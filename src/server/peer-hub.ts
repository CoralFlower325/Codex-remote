import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { nativeRpcFailure } from '../shared/native-error.js';
import { isTaskThread } from '../shared/thread-source.js';
import type { CodexBridge } from './codex-bridge.js';
import type { RemotePeer } from './http-connections.js';
import type { EventJournal } from './event-journal.js';
import type { QuestionTracker } from './question-tracker.js';
import type { MetadataReader } from './bootstrap.js';
import type { WorkspaceSnapshots } from './workspace-snapshots.js';
import type { EphemeralChats } from './ephemeral-chats.js';
import type { PushNotifications } from './push-notifications.js';
import type { QueueDispatcher } from './queue-dispatcher.js';
import type { SessionConnections } from './session-connections.js';

interface PeerServices {
  codexBridge: Pick<CodexBridge, 'getBinary' | 'getStatus' | 'getPendingServerRequests' | 'respondToServerRequest'>;
  eventJournal: EventJournal;
  questionTracker: QuestionTracker;
  metadataReader: MetadataReader;
  workspaceSnapshots: Pick<WorkspaceSnapshots, 'action'>;
  ephemeralChats: EphemeralChats<RemotePeer>;
  pushNotifications: Pick<PushNotifications, 'watch'>;
  queueDispatcher: Pick<QueueDispatcher, 'track'>;
  sessionConnections: SessionConnections;
}

export function createPeerHub({ codexBridge, eventJournal, questionTracker, metadataReader,
  workspaceSnapshots, ephemeralChats, pushNotifications, queueDispatcher, sessionConnections }: PeerServices) {
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
      if (!sessionConnections.allowed(client)) continue;
      if (client.bufferedAmount > 2 * 1024 * 1024) client.close(1013, 'Connection congested; resume.');
      else client.send(entry.payload);
    }
  }

  function send(socket: RemotePeer, message: ServerMessage): void {
    if (!sessionConnections.allowed(socket)) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  return { clients, connectClient, disconnectClient, handleClientMessage, broadcast };
}
