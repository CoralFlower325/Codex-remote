import { createPeerHub } from './peer-hub.js';
import { threadRouter } from './thread-router.js';
import { asyncRoute } from './http-route.js';
import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import { WebSocketServer } from 'ws';
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
import { MetadataReader, readWorkspaceBootstrap } from './bootstrap.js';
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
import { httpConnections, type RemotePeer } from './http-connections.js';
import { metadataRouter } from './metadata-router.js';
import { threadDockRouter } from './thread-dock-router.js';
import { historyItemRouter } from './history-item-router.js';
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
const ephemeralChats = new EphemeralChats<RemotePeer>(threadId => codexBridge.request('thread/unsubscribe', { threadId }));
const queueDispatcher = new QueueDispatcher(<T,>(method: import('../shared/protocol.js').ClientRpcMethod, params: unknown) =>
  codexBridge.request(method, params) as Promise<T>);
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const terminals = new TerminalManager(config.codexWorkdir);
const sessionConnections = new SessionConnections();
const { clients, connectClient, disconnectClient, handleClientMessage, broadcast } = createPeerHub({
  codexBridge, eventJournal, questionTracker, metadataReader, workspaceSnapshots,
  ephemeralChats, pushNotifications, queueDispatcher, sessionConnections
});
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

app.use(threadRouter({ requireAuth, codexBridge, workspaceSnapshots, pushNotifications,
  localImages, recordQuestions, reportImageFailure, config }));

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
