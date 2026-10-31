import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPeerHub } from './peer-hub.js';
import { MetadataReader } from './bootstrap.js';
import { EventJournal } from './event-journal.js';
import { EphemeralChats } from './ephemeral-chats.js';
import { QuestionTracker } from './question-tracker.js';
import { SessionConnections } from './session-connections.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { RemotePeer } from './http-connections.js';

const sessions: SessionConnections[] = [];
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); });
function fixture() {
  const native = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({}));
  const sessionConnections = new SessionConnections();
  sessions.push(sessionConnections);
  const eventJournal = new EventJournal();
  const hub = createPeerHub({
    codexBridge: { getBinary: () => 'synthetic', getStatus: () => 'ready',
      getPendingServerRequests: () => [], respondToServerRequest: vi.fn() },
    eventJournal, questionTracker: new QuestionTracker(), metadataReader: new MetadataReader(native),
    workspaceSnapshots: { action: vi.fn() }, ephemeralChats: new EphemeralChats<RemotePeer>(vi.fn()),
    pushNotifications: { watch: vi.fn() }, queueDispatcher: { track: vi.fn() }, sessionConnections
  });
  const peer = () => {
    const received: ServerMessage[] = [];
    const socket: RemotePeer = { readyState: 1, bufferedAmount: 0,
      send: raw => received.push(JSON.parse(raw)), close: vi.fn() };
    return { socket, received };
  };
  const send = (socket: RemotePeer, message: ClientMessage) => hub.handleClientMessage(socket, JSON.stringify(message));
  return { ...hub, native, peer, send, eventJournal };
}
describe('shared realtime peer policy', () => {
  it('filters watched events equally for both transports and replays only the subscribed journal', async () => {
    const hub = fixture(), ws = hub.peer(), http = hub.peer(), unsynced = hub.peer();
    for (const peer of [ws, http, unsynced]) hub.connectClient(peer.socket);
    await hub.send(ws.socket, { type: 'thread.watch', threadId: 'main', additionalThreadIds: ['side'] });
    await hub.send(http.socket, { type: 'thread.watch', threadId: 'main', additionalThreadIds: ['side'] });
    for (const threadId of ['main', 'side', 'other']) hub.broadcast({
      type: 'event', method: 'item/agentMessage/delta', params: { threadId, delta: threadId }
    });
    expect(ws.received.filter(message => message.type === 'event')).toEqual(
      http.received.filter(message => message.type === 'event'));
    expect(ws.received.filter(message => message.type === 'event')).toHaveLength(2);
    expect(unsynced.received.some(message => message.type === 'event')).toBe(false);
    const resumed = hub.peer();
    hub.connectClient(resumed.socket);
    await hub.send(resumed.socket, { type: 'sync.resume', epoch: hub.eventJournal.epoch,
      after: 0, threadId: 'side' });
    expect(resumed.received.filter(message => message.type === 'event')).toMatchObject([
      { params: { threadId: 'side' } }
    ]);
    expect(resumed.received.at(-1)).toMatchObject({ type: 'sync.ready', resumed: true, sequence: 3 });
    expect(hub.native).not.toHaveBeenCalled();
  });
  it('preserves native action failures without retrying or breaking the peer', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    hub.native.mockRejectedValueOnce(Object.assign(new Error('Native rate limit'), {
      code: -32000, data: { error: { message: 'Native rate limit',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } }
    }));
    await hub.send(peer.socket, { type: 'rpc', id: 'action', method: 'turn/start', params: { threadId: 'main' } });
    expect(hub.native).toHaveBeenCalledTimes(1);
    expect(peer.received.at(-1)).toMatchObject({ type: 'rpc.error', id: 'action',
      error: { code: -32000, message: 'Native rate limit' } });
    await hub.send(peer.socket, { type: 'ping' });
    expect(peer.received.at(-1)).toMatchObject({ type: 'pong' });
    expect(peer.socket.close).not.toHaveBeenCalled();
  });
  it('blocks revoked sessions before actions, pings, and event delivery', async () => {
    const hub = fixture(), peer = hub.peer();
    let allowed = true;
    hub.connectClient(peer.socket, () => allowed);
    await hub.send(peer.socket, { type: 'thread.watch', threadId: 'main' });
    const before = peer.received.length;
    allowed = false;
    await hub.send(peer.socket, { type: 'rpc', id: 'blocked', method: 'turn/start', params: {} });
    await hub.send(peer.socket, { type: 'ping' });
    hub.broadcast({ type: 'event', method: 'turn/completed', params: { threadId: 'main' } });
    expect(hub.native).not.toHaveBeenCalled();
    expect(peer.received).toHaveLength(before);
    expect(peer.socket.close).toHaveBeenCalledWith(1008, 'Authentication expired');
    hub.disconnectClient(peer.socket);
    expect(hub.clients.size).toBe(0);
  });
});
