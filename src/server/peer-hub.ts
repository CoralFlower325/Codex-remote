import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { nativeRpcFailure, NativeRpcError } from '../shared/native-error.js';
import { isSideConversationThread, isTaskThread } from '../shared/thread-source.js';
import type { TurnTiming } from '../shared/turn-timing.js';
import type { CodexBridge } from './codex-bridge.js';
import type { RemotePeer } from './http-connections.js';
import type { EventJournal } from './event-journal.js';
import type { QuestionTracker } from './question-tracker.js';
import type { MetadataReader } from './bootstrap.js';
import type { WorkspaceSnapshots } from './workspace-snapshots.js';
import type { ThreadHistoryCache } from './thread-history-cache.js';
import type { EphemeralChats } from './ephemeral-chats.js';
import type { PushNotifications } from './push-notifications.js';
import type { QueueDispatcher } from './queue-dispatcher.js';
import type { SessionConnections } from './session-connections.js';
import { isAllowedRpcMethod } from '../shared/rpc-methods.js';
import type { ActionLedger } from './action-ledger.js';
import { needsActionIdentity } from '../shared/action-policy.js';

const MAX_PEER_BUFFER = 2 * 1024 * 1024;

function validMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const id = (entry: unknown) => typeof entry === 'string' && entry.length > 0 && entry.length <= 1024;
  const watches = () => (message.threadId === null || id(message.threadId)) &&
    (message.additionalThreadIds === undefined || Array.isArray(message.additionalThreadIds) &&
      message.additionalThreadIds.length <= 100 && message.additionalThreadIds.every(id));
  switch (message.type) {
    case 'ping': return true;
    case 'thread.watch': return watches();
    case 'sync.resume': return watches() && (message.epoch === null || id(message.epoch)) &&
      Number.isSafeInteger(message.after) && (message.after as number) >= 0;
    case 'rpc': return id(message.id) && (message.actionId === undefined ||
      typeof message.actionId === 'string' && /^[a-f0-9-]{36}$/i.test(message.actionId)) &&
      typeof message.method === 'string' && isAllowedRpcMethod(message.method) &&
      (message.params === undefined || message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params));
    case 'server.request.respond': return id(message.requestId) || typeof message.requestId === 'number' &&
      Number.isSafeInteger(message.requestId);
    default: return false;
  }
}

interface PeerServices {
  codexBridge: Pick<CodexBridge, 'getBinary' | 'getStatus' | 'getPendingServerRequests' | 'respondToServerRequest'>;
  eventJournal: EventJournal;
  questionTracker: QuestionTracker;
  metadataReader: MetadataReader;
  workspaceSnapshots: Pick<WorkspaceSnapshots, 'action'>;
  historyCache?: Pick<ThreadHistoryCache, 'action'>;
  ephemeralChats: EphemeralChats<RemotePeer>;
  pushNotifications: Pick<PushNotifications, 'watch'>;
  queueDispatcher: Pick<QueueDispatcher, 'track'>;
  sessionConnections: SessionConnections;
  actionLedger?: ActionLedger;
}

export function createPeerHub({ codexBridge, eventJournal, questionTracker, metadataReader,
  workspaceSnapshots, historyCache, ephemeralChats, pushNotifications, queueDispatcher, sessionConnections, actionLedger }: PeerServices) {
  const clients = new Set<RemotePeer>();
  const synchronizedClients = new Set<RemotePeer>();
  const watchedThreads = new Map<RemotePeer, Set<string>>();

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
      const value: unknown = JSON.parse(raw);
      if (!validMessage(value)) throw new Error('Invalid message structure.');
      message = value;
    } catch {
      send(socket, { type: 'error', error: { message: 'Invalid client message.' } });
      return;
    }
    try { await dispatchClientMessage(socket, message); }
    catch { send(socket, { type: 'error', error: { message: 'Message handling failed.' } }); }
  }

  async function dispatchClientMessage(socket: RemotePeer, message: ClientMessage): Promise<void> {
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
        if (!safeSend(socket, entry.payload)) break;
      }
      send(socket, { type: 'questions.snapshot', counts: questionTracker.snapshot() });
      send(socket, { type: 'server.request.snapshot', requests: codexBridge.getPendingServerRequests() });
      send(socket, { type: 'sync.ready', epoch: replay.epoch, sequence: replay.sequence, resumed: replay.resumed });
      synchronizedClients.add(socket);
      return;
    }

    if (message.type === 'rpc') {
      try {
        if (actionLedger && needsActionIdentity(message.method) && !message.actionId) {
          throw new NativeRpcError({ code: -32001, message: '当前页面缺少安全操作标识，请保存草稿后更新网页版本再操作。' });
        }
        if (needsActionIdentity(message.method) && codexBridge.getStatus() !== 'ready') {
          throw new NativeRpcError({ code: -32001, message: 'Desktop 尚未连接，此操作没有发送。请先恢复主机连接再试。' });
        }
        const params = message.params as { ephemeral?: boolean; threadId?: string;
          clientUserMessageId?: string; input?: unknown[]; expectedTurnId?: string } | undefined;
        const dispatch = async () => {
          const result = await metadataReader.read(message.method, message.params ?? {});
          if ((message.method === 'turn/start' || message.method === 'turn/steer') &&
              params?.threadId && params.clientUserMessageId && params.input) {
            const turnId = message.method === 'turn/start' ? (result as { turn: { id: string } }).turn.id : params.expectedTurnId!;
            ephemeralChats.recordInput(params.threadId, turnId, params.clientUserMessageId, params.input);
          }
          return result;
        };
        const result = message.actionId && actionLedger
          ? await actionLedger.execute(message.actionId, message.method, message.params ?? {}, dispatch)
          : await dispatch();
        workspaceSnapshots.action(message.method, message.params as Record<string, unknown> ?? {});
        historyCache?.action(message.method, message.params as Record<string, unknown> ?? {});
        if (message.method === 'project/create') metadataReader.clear('project/list');
        if (/^thread\/(?:start|fork|resume|read)$/.test(message.method)) {
          const thread = (result as { thread?: {
            id: string; source?: unknown; ephemeral?: boolean;
            turns?: Array<{ id: string; status?: TurnTiming['status']; items?: Array<Record<string, unknown>> }>;
          } }).thread;
          const startsRemoteEphemeral = /^(?:thread\/start|thread\/fork)$/.test(message.method) &&
            params?.ephemeral === true;
          const alreadyTracked = thread?.id ? ephemeralChats.snapshot(thread.id) !== null : false;
          if (thread?.ephemeral && !isSideConversationThread(thread) &&
              (startsRemoteEphemeral || alreadyTracked)) {
            if (startsRemoteEphemeral) ephemeralChats.add(thread.id, socket);
            ephemeralChats.recordThread(thread.id, thread.turns ?? []);
            if (startsRemoteEphemeral && socket.readyState !== WebSocket.OPEN) ephemeralChats.disconnect(socket);
          }
          if (thread && isTaskThread(thread)) pushNotifications.watch(thread.id);
        }
        if (message.method === 'thread/unsubscribe' && params?.threadId) ephemeralChats.remove(params.threadId);
        if (message.method === 'thread/queue/add' && params?.threadId) void queueDispatcher.track(params.threadId);
        send(socket, { type: 'rpc.result', id: message.id, result });
      } catch (error) {
        send(socket, {
          type: 'rpc.error',
          id: message.id,
          error: nativeRpcFailure(error)
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
      if (!sessionConnections.allowed(client, false)) continue;
      safeSend(client, entry.payload);
    }
  }

  function safeSend(socket: RemotePeer, raw: string): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount + Buffer.byteLength(raw) > MAX_PEER_BUFFER) {
      try { socket.close(1013, 'Connection congested; resume.'); } catch { /* Already closed. */ }
      return false;
    }
    try { socket.send(raw); return true; }
    catch {
      disconnectClient(socket);
      try { socket.close(1011, 'Message delivery failed'); } catch { /* Already closed. */ }
      return false;
    }
  }

  function send(socket: RemotePeer, message: ServerMessage): void {
    if (!sessionConnections.allowed(socket, false)) return;
    safeSend(socket, JSON.stringify(message));
  }

  return { clients, connectClient, disconnectClient, handleClientMessage, broadcast };
}
