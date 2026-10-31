import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import { WebSocket, WebSocketServer } from 'ws';

import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { permissionProfileId, type PermissionProfile, type PermissionSettings } from '../shared/permissions.js';
import {
  authFilePath,
  clearSessionCookie,
  isLoopback,
  isPasswordConfigured,
  issueSession,
  readSessionCookie,
  revokeSessionCookie,
  sessionCookie,
  setPassword,
  verifyPassword
} from './auth.js';
import { codexBridge } from './codex-bridge.js';
import { config } from './config.js';
import { desktopBridge } from './desktop-bridge.js';
import { readConversationHistoryPage, readThreadHistoryAround, readThreadHistoryPage, readThreadOutline } from './thread-history.js';
import { readThreadTimings } from './thread-open.js';
import { MetadataReader, readWorkspaceBootstrap, withReadDeadline } from './bootstrap.js';
import { WorkspaceSnapshots } from './workspace-snapshots.js';
import { TerminalManager } from './terminal-manager.js';
import { handleTerminalSocket } from './terminal-socket.js';
import { EphemeralChats } from './ephemeral-chats.js';
import { QueueDispatcher } from './queue-dispatcher.js';
import { QuestionTracker } from './question-tracker.js';
import { EventJournal } from './event-journal.js';
import { filePreviewRouter } from './file-preview.js';
import { LocalImages, imageExtensions } from './local-images.js';
import { PushNotifications } from './push-notifications.js';
import { isTaskThread } from '../shared/thread-source.js';
import { httpConnections, type RemotePeer } from './http-connections.js';
import { metadataRouter } from './metadata-router.js';
import { threadDockRouter } from './thread-dock-router.js';
import { historyItemRouter } from './history-item-router.js';
import { readThreadSummaryPage } from './thread-summary.js';
import { SessionConnections } from './session-connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const lanServer = config.lanPort ? http.createServer(app) : null;
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    threshold: 1024,
    concurrencyLimit: 4
  }
});
const clients = new Set<RemotePeer>();
const synchronizedClients = new Set<RemotePeer>();
const eventJournal = new EventJournal();
const questionTracker = new QuestionTracker();
const localImages = new LocalImages(path.join(config.dataDir, 'image-attachments'));
const metadataReader = new MetadataReader((method, params) => codexBridge.request(method, params));
const workspaceSnapshots = new WorkspaceSnapshots((method, params) => codexBridge.request(method, params));
const pushNotifications = new PushNotifications(
  config.dataDir,
  config.publicOrigin ?? 'https://example.com',
  threadId => codexBridge.request('thread/read', { threadId, includeTurns: false })
);
const watchedThreads = new Map<RemotePeer, Set<string>>();
const ephemeralChats = new EphemeralChats<RemotePeer>(threadId => codexBridge.request('thread/unsubscribe', { threadId }));
const queueDispatcher = new QueueDispatcher(<T,>(method: import('../shared/protocol.js').ClientRpcMethod, params: unknown) =>
  codexBridge.request(method, params) as Promise<T>);
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const terminals = new TerminalManager(config.codexWorkdir);
const sessionConnections = new SessionConnections();
terminalWss.on('connection', (socket, req) => {
  sessionConnections.add(socket, () => Boolean(readSessionCookie(req.headers.cookie, req.headers['user-agent'])));
  socket.on('close', () => sessionConnections.delete(socket));
  handleTerminalSocket(socket, terminals, () => sessionConnections.allowed(socket));
});

app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(compression());
app.use('/api/connection', requireAuth, (req, _res, next) => {
  assertTrustedOrigin(req);
  next();
}, express.json({ limit: '100mb' }), httpConnections({
  session: req => readSessionCookie(req.headers.cookie)!.sid,
  connect: (peer, req) => connectClient(peer, () => isAuthenticated(req)),
  disconnect: disconnectClient,
  message: handleClientMessage
}));
app.use(express.json({ limit: '1mb' }));

function isAuthenticated(req: Request): boolean {
  return Boolean(readSessionCookie(req.headers.cookie, req.headers['user-agent']));
}

function isLocalRequest(req: Request): boolean {
  return isLoopback(req.ip);
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

function allowedOrigins(): string[] {
  const origin = config.publicOrigin;
  const defaults = [
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173'
  ];
  return [...new Set([...(origin ? [origin] : []), ...config.allowedOrigins, ...defaults])];
}

function assertTrustedOrigin(req: Request): void {
  const origin = req.get('origin');
  if (!origin) return;
  if (allowedOrigins().includes(origin)) return;
  throw new Error('Untrusted request origin.');
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  next();
}

function clientAddress(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

const loginAttempts = new Map<string, { count: number; blockedUntil: number; lastAttempt: number }>();

function checkLoginRateLimit(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return;
  if (entry.blockedUntil > now) {
    const seconds = Math.ceil((entry.blockedUntil - now) / 1000);
    throw new Error(`Too many attempts. Try again in ${seconds} seconds.`);
  }
  if (now - entry.lastAttempt > 10 * 60_000) loginAttempts.delete(key);
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key) ?? { count: 0, blockedUntil: 0, lastAttempt: now };
  entry.count += 1;
  entry.lastAttempt = now;
  entry.blockedUntil = entry.count >= 5 ? now + Math.min(10 * 60_000, entry.count * 20_000) : 0;
  loginAttempts.set(key, entry);
}

function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    codex: codexBridge.getStatus(),
    transport: codexBridge.getTransport(),
    binary: codexBridge.getBinary(),
    passwordConfigured: isPasswordConfigured()
  });
});

app.get(
  '/api/auth/status',
  asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const configured = isPasswordConfigured();
    res.json({
      configured,
      authenticated: isAuthenticated(req),
      setupAllowed: !configured && isLocalRequest(req),
      authFile: isLocalRequest(req) ? authFilePath() : undefined
    });
  })
);

app.post(
  '/api/auth/setup',
  asyncRoute(async (req, res) => {
    assertTrustedOrigin(req);
    if (isPasswordConfigured()) {
      res.status(409).json({ error: 'Password is already configured. Use the local CLI to reset it.' });
      return;
    }
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: 'Initial password setup is only allowed from this computer.' });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    await setPassword(password);
    const token = issueSession(req.headers['user-agent']);
    res.setHeader('Set-Cookie', sessionCookie(token, isSecureRequest(req)));
    res.json({ ok: true });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    assertTrustedOrigin(req);
    if (!isPasswordConfigured()) {
      res.status(409).json({ error: 'Password is not configured yet.' });
      return;
    }

    const key = clientAddress(req);
    checkLoginRateLimit(key);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const valid = await verifyPassword(password);
    if (!valid) {
      recordFailedLogin(key);
      res.status(401).json({ error: 'Incorrect password.' });
      return;
    }

    clearLoginFailures(key);
    const token = issueSession(req.headers['user-agent']);
    res.setHeader('Set-Cookie', sessionCookie(token, isSecureRequest(req)));
    res.json({ ok: true });
  })
);

app.post(
  '/api/auth/logout',
  asyncRoute(async (req, res) => {
    assertTrustedOrigin(req);
    revokeSessionCookie(req.headers.cookie);
    res.setHeader('Set-Cookie', clearSessionCookie(isSecureRequest(req)));
    res.json({ ok: true });
  })
);

app.get(
  '/api/bootstrap',
  asyncRoute(async (req, res) => {
    const configured = isPasswordConfigured();
    const authenticated = isAuthenticated(req);
    const cursor = { epoch: eventJournal.epoch, sequence: eventJournal.sequence };
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured,
      authenticated,
      setupAllowed: !configured && isLocalRequest(req),
      workspace: authenticated
        ? { ...await readWorkspaceBootstrap((method, params) =>
          method === 'thread/list' ? workspaceSnapshots.list() : metadataReader.read(method, params)), cursor }
        : null
    });
  })
);

app.get('/api/threads', requireAuth, asyncRoute(async (req, res) => {
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  res.setHeader('Cache-Control', 'no-store');
  res.json(await workspaceSnapshots.list(cursor, req.query.archived === 'true', req.query.fresh === '1'));
}));

app.use('/api/metadata', metadataRouter(requireAuth, metadataReader.read));
app.use('/api/thread/dock', threadDockRouter(requireAuth, (method, params) => codexBridge.request(method, params)));
app.use('/api/thread/item', historyItemRouter(requireAuth, (method, params) => codexBridge.request(method, params)));

app.use('/api/notifications', requireAuth, (req, _res, next) => {
  assertTrustedOrigin(req);
  next();
}, pushNotifications.router());

app.get('/api/connections', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ publicOrigin: config.publicOrigin, lanOrigins: lanServer?.listening ? config.lanOrigins : [] });
});

app.get(
  '/api/desktop/status',
  requireAuth,
  asyncRoute(async (_req, res) => {
    res.json(await desktopBridge.getStatus());
  })
);

app.get(
  '/api/side-chat',
  requireAuth,
  asyncRoute((req, res) => {
    const snapshot = ephemeralChats.snapshot(String(req.query.threadId ?? ''));
    if (!snapshot) { res.status(404).json({ error: 'Temporary chat is no longer available.' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json(snapshot);
  })
);

app.get(
  '/api/thread/open',
  requireAuth,
  asyncRoute(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required.' });
      return;
    }
    const mode = req.query.mode === 'new' || req.query.mode === 'read' ? req.query.mode : 'resume';
    res.setHeader('Cache-Control', 'no-store');
    const result = await workspaceSnapshots.open(threadId, mode, req.query.fresh === '1');
    const thread = (result.result as { thread?: { id: string; source?: unknown; ephemeral?: boolean } }).thread;
    if (thread && isTaskThread(thread)) pushNotifications.watch(thread.id);
    recordQuestions(threadId, result.items.map(entry => entry.item));
    for (const entry of result.items) void localImages.remember(entry.item).catch(reportImageFailure);
    if (!res.destroyed) res.json(result);
  })
);

app.get('/api/thread/summary', requireAuth, asyncRoute(async (req, res) => {
  const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
  if (!threadId) { res.status(400).json({ error: 'threadId is required.' }); return; }
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const attachmentCursor = typeof req.query.attachmentsCursor === 'string' ? req.query.attachmentsCursor : null;
  res.json(await withReadDeadline(readThreadSummaryPage(
    (method, params) => codexBridge.request(method, params), threadId, cursor, attachmentCursor,
    req.query.attachmentsOnly === '1'
  )));
}));

app.get('/api/thread/timings', requireAuth, asyncRoute(async (req, res) => {
  const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
  if (!threadId) { res.status(400).json({ error: 'threadId is required.' }); return; }
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  res.json(await (cursor ? withReadDeadline(readThreadTimings(
    (method, params) => codexBridge.request(method, params), threadId, cursor
  )) : workspaceSnapshots.readTimings(threadId, req.query.fresh === '1')));
}));

app.get(
  '/api/thread/history',
  requireAuth,
  asyncRoute(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required.' });
      return;
    }
    const direction = typeof req.query.after === 'string' ? 'asc' : 'desc';
    const cursor = typeof req.query.after === 'string' ? req.query.after : typeof req.query.before === 'string' ? req.query.before : null;
    const limitValue =
      typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200;
    const limit = Number.isFinite(limitValue) ? Math.min(400, Math.max(1, limitValue)) : 200;
    res.setHeader('Cache-Control', 'no-store');
    const request = (method: import('../shared/protocol.js').ClientRpcMethod, params: unknown) => codexBridge.request(method, params);
    const result = await withReadDeadline(cursor && direction === 'desc' && req.query.conversation === '1'
      ? readConversationHistoryPage(request, threadId, cursor, Math.min(limit, 100))
      : readThreadHistoryPage(request, threadId, cursor, limit, direction));
    recordQuestions(threadId, result.items.map(entry => entry.item));
    for (const entry of result.items) void localImages.remember(entry.item).catch(reportImageFailure);
    res.json(result);
  })
);

app.get(
  '/api/thread/outline',
  requireAuth,
  asyncRoute(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
    if (!threadId) { res.status(400).json({ error: 'threadId is required.' }); return; }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readThreadOutline((method, params) => codexBridge.request(method, params), threadId, cursor));
  })
);

app.get(
  '/api/thread/around',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { threadId, turnId, itemId } = req.query;
    if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId ||
        typeof itemId !== 'string' || !itemId) {
      res.status(400).json({ error: 'threadId, turnId and itemId are required.' }); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readThreadHistoryAround((method, params) => codexBridge.request(method, params), threadId, turnId, itemId));
  })
);

app.get(
  '/api/permissions',
  requireAuth,
  asyncRoute(async (req, res) => {
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : config.codexWorkdir;
    const profiles: PermissionProfile[] = [];
    let cursor: string | null = null;
    do {
      const result = await codexBridge.request('permissionProfile/list', { cwd, limit: 100, ...(cursor ? { cursor } : {}) }) as {
        data: PermissionProfile[]; nextCursor?: string | null;
      };
      profiles.push(...result.data.filter((profile) => profile.allowed));
      cursor = result.nextCursor ?? null;
    } while (cursor);
    const result = await codexBridge.request('config/read', { cwd, includeLayers: false }) as { config: PermissionSettings };
    const defaultProfile = permissionProfileId(result.config);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: profiles, defaultProfile: profiles.some((profile) => profile.id === defaultProfile) ? defaultProfile : null });
  })
);

app.use('/api/file-preview', filePreviewRouter(requireAuth));

app.get(
  '/api/local-image',
  requireAuth,
  asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const requestedPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!requestedPath) {
      res.status(400).json({ error: 'path is required.' });
      return;
    }
    const imagePath = path.resolve(requestedPath);
    const extension = path.extname(imagePath).toLowerCase();
    if (!imageExtensions.has(extension)) {
      res.status(415).json({ error: 'Only local image files are supported.' });
      return;
    }
    const retained = await localImages.resolve(imagePath);
    if (!retained) {
      res.status(404).json({ error: 'Local image was not found.' });
      return;
    }
    res.sendFile(retained);
  })
);

const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws' && url.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (origin && !allowedOrigins().includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!readSessionCookie(req.headers.cookie, req.headers['user-agent'])) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const target = url.pathname === '/ws/terminal' ? terminalWss : wss;
    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
};
server.on('upgrade', handleUpgrade);
lanServer?.on('upgrade', handleUpgrade);

wss.on('connection', (socket, req) => {
  connectClient(socket, () => Boolean(readSessionCookie(req.headers.cookie, req.headers['user-agent'])));
  socket.on('message', (data) => {
    void handleClientMessage(socket, data.toString());
  });
  socket.on('close', () => disconnectClient(socket));
});

function connectClient(socket: RemotePeer, authorized?: () => boolean): void {
  if (authorized) sessionConnections.add(socket, authorized);
  clients.add(socket);
  watchedThreads.set(socket, new Set());
  send(socket, {
    type: 'hello',
    connectedAt: new Date().toISOString(),
    codexAvailable: true,
    binary: codexBridge.getBinary()
  });
  send(socket, {
    type: 'bridge.status',
    status: codexBridge.getStatus()
  });
  send(socket, { type: 'questions.snapshot', counts: questionTracker.snapshot() });
  send(socket, {
    type: 'server.request.snapshot',
    requests: codexBridge.getPendingServerRequests()
  });

}

function disconnectClient(socket: RemotePeer): void {
  sessionConnections.delete(socket);
  clients.delete(socket);
  synchronizedClients.delete(socket);
  watchedThreads.delete(socket);
  ephemeralChats.disconnect(socket);
}

async function handleClientMessage(socket: RemotePeer, raw: string): Promise<void> {
  if (!sessionConnections.allowed(socket)) return;
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(socket, { type: 'error', error: { message: 'Invalid JSON message.' } });
    return;
  }

  if (message.type === 'ping') {
    send(socket, { type: 'pong', at: new Date().toISOString() });
    return;
  }
  if (message.type === 'thread.watch') {
    const ids = [message.threadId, ...(message.additionalThreadIds ?? [])].filter((id): id is string => typeof id === 'string');
    watchedThreads.set(socket, new Set(ids));
    ephemeralChats.claim(message.additionalThreadIds ?? [], socket);
    synchronizedClients.add(socket);
    return;
  }
  if (message.type === 'sync.resume') {
    const ids = new Set([message.threadId, ...(message.additionalThreadIds ?? [])]
      .filter((id): id is string => typeof id === 'string'));
    watchedThreads.set(socket, ids);
    ephemeralChats.claim(message.additionalThreadIds ?? [], socket);
    const replay = eventJournal.resume(message.epoch, message.after, ids);
    for (const entry of replay.entries) {
      if (!sessionConnections.allowed(socket)) break;
      socket.send(entry.payload);
    }
    send(socket, { type: 'questions.snapshot', counts: questionTracker.snapshot() });
    send(socket, { type: 'server.request.snapshot', requests: codexBridge.getPendingServerRequests() });
    send(socket, { type: 'sync.ready', epoch: replay.epoch, sequence: replay.sequence, resumed: replay.resumed });
    synchronizedClients.add(socket);
    return;
  }

  if (message.type === 'rpc') {
    try {
      const result = await metadataReader.read(message.method, message.params ?? {});
      workspaceSnapshots.action(message.method, message.params as Record<string, unknown> ?? {});
      if (message.method === 'project/create') metadataReader.clear('project/list');
      const params = message.params as { ephemeral?: boolean; threadId?: string;
        clientUserMessageId?: string; input?: unknown[]; expectedTurnId?: string } | undefined;
      if ((message.method === 'thread/start' || message.method === 'thread/fork') && params?.ephemeral) {
        const id = (result as { thread: { id: string } }).thread.id;
        ephemeralChats.add(id, socket);
        if (socket.readyState !== WebSocket.OPEN) ephemeralChats.disconnect(socket);
      }
      if (/^thread\/(?:start|fork|resume|read)$/.test(message.method) && !params?.ephemeral) {
        const thread = (result as { thread?: { id: string; source?: unknown; ephemeral?: boolean } }).thread;
        if (thread && isTaskThread(thread)) pushNotifications.watch(thread.id);
      }
      if (message.method === 'thread/unsubscribe' && params?.threadId) ephemeralChats.remove(params.threadId);
      if ((message.method === 'turn/start' || message.method === 'turn/steer') &&
          params?.threadId && params.clientUserMessageId && params.input) {
        const turnId = message.method === 'turn/start' ? (result as { turn: { id: string } }).turn.id : params.expectedTurnId!;
        ephemeralChats.recordInput(params.threadId, turnId, params.clientUserMessageId, params.input);
      }
      if (message.method === 'thread/queue/add' && params?.threadId) void queueDispatcher.track(params.threadId);
      send(socket, { type: 'rpc.result', id: message.id, result });
    } catch (error) {
      send(socket, {
        type: 'rpc.error',
        id: message.id,
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    }
    return;
  }

  if (message.type === 'server.request.respond') {
    try {
      await codexBridge.respondToServerRequest(message.requestId, message.result, message.error);
      broadcast({ type: 'server.request.resolved', requestId: message.requestId });
    } catch (error) {
      send(socket, {
        type: 'server.request.failed',
        requestId: message.requestId,
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    }
  }
}

function broadcast(message: ServerMessage): void {
  const entry = eventJournal.append(message);
  const threadId = entry.threadId;
  const recipients = [...clients].filter((client) =>
    client.readyState === WebSocket.OPEN && synchronizedClients.has(client) &&
      (!threadId || watchedThreads.get(client)?.has(threadId))
  );
  if (recipients.length === 0) return;
  for (const client of recipients) {
    if (!sessionConnections.allowed(client)) continue;
    if (client.bufferedAmount > 2 * 1024 * 1024) client.close(1013, 'Connection congested; resume.');
    else client.send(entry.payload);
  }
}

function send(socket: RemotePeer, message: ServerMessage): void {
  if (!sessionConnections.allowed(socket)) return;
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function recordQuestions(threadId: string, items: unknown[]): void {
  if (questionTracker.ingest(threadId, items)) {
    broadcast({ type: 'questions.snapshot', counts: questionTracker.snapshot() });
  }
}

codexBridge.on('event', ({ method, params }) => {
  const questionEvent = /^(item|turn)\/(started|completed)$/.test(method);
  const questionThreadId = typeof params?.threadId === 'string' ? params.threadId : '';
  const previousQuestions = questionEvent ? questionTracker.pendingIds(questionThreadId) : new Set<string>();
  if (questionTracker.event(method, params ?? {})) {
    broadcast({ type: 'questions.snapshot', counts: questionTracker.snapshot() });
  }
  if (questionEvent) {
    const added = [...questionTracker.pendingIds(questionThreadId)].filter(id => !previousQuestions.has(id));
    if (added.length) void pushNotifications.notifyQuestions(params ?? {}, added);
  }
  workspaceSnapshots.event(method, params ?? {});
  if (method === 'item/started' || method === 'item/completed') {
    void localImages.remember(params?.item).catch(reportImageFailure);
  }
  if (method === 'turn/completed') {
    for (const item of params?.turn?.items ?? []) void localImages.remember(item).catch(reportImageFailure);
    void pushNotifications.notifyTurn(params ?? {});
  }
  ephemeralChats.record(method, params ?? {});
  broadcast({ type: 'event', method, params });
  if (method === 'turn/completed' && params?.threadId) void queueDispatcher.drain(params.threadId);
});

function reportImageFailure(): void {
  console.warn('Could not retain a local image attachment.');
}
codexBridge.on('server-request', ({ requestId, method, params }) => {
  broadcast({ type: 'server.request', requestId, method, params });
  void pushNotifications.notifyApproval(params ?? {}, method);
});
codexBridge.on('status', (status) => {
  if (status !== 'ready') {
    eventJournal.reset();
    metadataReader.clear();
    workspaceSnapshots.clear();
  }
  broadcast({ type: 'bridge.status', status });
});
codexBridge.on('resolved', (requestId) => broadcast({ type: 'server.request.resolved', requestId }));
codexBridge.on('stderr', (message: string) => {
  console.warn('[codex app-server]', message);
});

const productionClientDir = path.resolve(__dirname, '../../dist/client');
if (fs.existsSync(productionClientDir)) {
  app.use(
    express.static(productionClientDir, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    })
  );
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/ws' || req.path === '/health') return next();
    res.sendFile(path.join(productionClientDir, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[request]', message);
  res.status(500).json({ error: message });
});

lanServer?.on('error', error => { console.error('[LAN]', error.message); });
lanServer?.listen(config.lanPort, '0.0.0.0', () => {
  console.log(`Codex Remote LAN: ${config.lanOrigins.join(', ')}`);
});
server.listen(config.port, config.host, () => {
  console.log(`Codex Remote listening on http://${config.host}:${config.port}`);
  console.log(`Codex binary: ${codexBridge.getBinary()}`);
  console.log(`Auth file: ${authFilePath()}`);
  void codexBridge.ensureStarted().catch((error) => {
    console.error('[codex] Failed to start app-server:', error instanceof Error ? error.message : String(error));
  });
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  sessionConnections.dispose();
  for (const client of terminalWss.clients) client.close();
  terminals.dispose();
  for (const client of clients) client.close();
  codexBridge.shutdown();
  lanServer?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
