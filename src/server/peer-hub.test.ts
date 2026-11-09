import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPeerHub } from './peer-hub.js';
import { MetadataReader } from './bootstrap.js';
import { EventJournal } from './event-journal.js';
import { EphemeralChats } from './ephemeral-chats.js';
import { QuestionTracker } from './question-tracker.js';
import { SessionConnections } from './session-connections.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { RemotePeer } from './http-connections.js';
import { ActionLedger } from './action-ledger.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const sessions: SessionConnections[] = [];
const directories: string[] = [];
afterEach(async () => {
  sessions.splice(0).forEach(session => session.dispose());
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
function fixture(actionLedger?: ActionLedger) {
  const native = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({}));
  const sessionConnections = new SessionConnections();
  sessions.push(sessionConnections);
  const eventJournal = new EventJournal();
  const ephemeralChats = new EphemeralChats<RemotePeer>(vi.fn());
  const hub = createPeerHub({
    codexBridge: { getBinary: () => 'synthetic', getStatus: () => 'ready',
      getPendingServerRequests: () => [], respondToServerRequest: vi.fn() },
    eventJournal, questionTracker: new QuestionTracker(), metadataReader: new MetadataReader(native),
    workspaceSnapshots: { action: vi.fn() }, ephemeralChats,
    pushNotifications: { watch: vi.fn() }, queueDispatcher: { track: vi.fn() }, sessionConnections,
    ...(actionLedger ? { actionLedger } : {})
  });
  const peer = () => {
    const received: ServerMessage[] = [];
    const socket: RemotePeer = { readyState: 1, bufferedAmount: 0,
      send: raw => received.push(JSON.parse(raw)), close: vi.fn() };
    return { socket, received };
  };
  const send = (socket: RemotePeer, message: ClientMessage) => hub.handleClientMessage(socket, JSON.stringify(message));
  return { ...hub, native, peer, send, eventJournal, ephemeralChats };
}
describe('shared realtime peer policy', () => {
  it('closes a targeted peer before a result can exceed the bounded buffer', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    Object.defineProperty(peer.socket, 'bufferedAmount', { value: 3 * 1024 * 1024 });
    const close = vi.spyOn(peer.socket, 'close');
    await hub.send(peer.socket, { type: 'ping' });
    expect(close).toHaveBeenCalledWith(1013, expect.stringContaining('congested'));
  });
  it('requires write identities and returns cached confirmations without duplicate native or ephemeral input', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-peer-actions-'));
    directories.push(directory);
    const hub = fixture(new ActionLedger(directory)), peer = hub.peer();
    hub.connectClient(peer.socket);
    const params = { threadId: 'remote-side', clientUserMessageId: 'first-message',
      input: [{ type: 'text', text: 'Synthetic input' }] };
    await hub.send(peer.socket, { type: 'rpc', id: 'missing', method: 'turn/start', params });
    expect(hub.native).not.toHaveBeenCalled();
    expect(peer.received.at(-1)).toMatchObject({ type: 'rpc.error', error: { code: -32001 } });
    hub.ephemeralChats.adopt('remote-side', peer.socket);
    hub.native.mockResolvedValue({ turn: { id: 'turn-one' } });
    const record = vi.spyOn(hub.ephemeralChats, 'recordInput');
    const actionId = crypto.randomUUID();
    await hub.send(peer.socket, { type: 'rpc', id: 'first', method: 'turn/start', params, actionId });
    await hub.send(peer.socket, { type: 'rpc', id: 'retry', method: 'turn/start', actionId,
      params: { ...params, clientUserMessageId: 'new-random-message-id' } });
    expect(hub.native).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(peer.received.at(-1)).toMatchObject({ type: 'rpc.result', result: { turn: { id: 'turn-one' } } });
  });
  it('keeps a previously registered Remote-owned ephemeral thread in reconnect memory', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    hub.ephemeralChats.adopt('remote-side', peer.socket);
    hub.native.mockResolvedValueOnce({ thread: { id: 'remote-side', ephemeral: true,
      threadSource: 'codex_remote', turns: [{ id: 'turn', status: 'inProgress', startedAt: 10,
        items: [{ id: 'answer', type: 'agentMessage', text: 'Synchronized' }] }] } });
    await hub.send(peer.socket, { type: 'rpc', id: 'read-side', method: 'thread/read',
      params: { threadId: 'remote-side', includeTurns: true } });
    expect(peer.received.at(-1)).toMatchObject({ type: 'rpc.result', id: 'read-side' });
    expect(hub.ephemeralChats.snapshot('remote-side')).toMatchObject({
      activeTurnId: 'turn',
      items: [{ id: 'answer', turnId: 'turn', text: 'Synchronized' }]
    });
  });

  it('does not claim an unrelated Desktop ephemeral thread from a read', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    hub.native.mockResolvedValueOnce({ thread: { id: 'desktop-ephemeral', ephemeral: true,
      threadSource: 'desktop', turns: [] } });
    await hub.send(peer.socket, { type: 'rpc', id: 'read-side', method: 'thread/read',
      params: { threadId: 'desktop-ephemeral', includeTurns: true } });
    expect(hub.ephemeralChats.snapshot('desktop-ephemeral')).toBeNull();
  });

  it('does not transfer a Remote side-chat lifetime to another read-only client', async () => {
    const hub = fixture(), owner = hub.peer(), reader = hub.peer();
    hub.connectClient(owner.socket);
    hub.connectClient(reader.socket);
    hub.ephemeralChats.add('side', owner.socket);
    const adopt = vi.spyOn(hub.ephemeralChats, 'adopt');
    hub.native.mockResolvedValueOnce({ thread: { id: 'side', ephemeral: true,
      threadSource: 'codex_remote', turns: [] } });
    await hub.send(reader.socket, { type: 'rpc', id: 'read-side', method: 'thread/read',
      params: { threadId: 'side', includeTurns: true } });
    expect(adopt).not.toHaveBeenCalled();
    expect(hub.ephemeralChats.snapshot('side')).not.toBeNull();
  });

  it('never takes ownership of a Desktop-managed side conversation', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    hub.native.mockResolvedValueOnce({ thread: { id: 'desktop-side', ephemeral: true,
      threadSource: 'side_chat', turns: [] } });
    await hub.send(peer.socket, { type: 'rpc', id: 'read-side', method: 'thread/read',
      params: { threadId: 'desktop-side', includeTurns: true } });
    expect(hub.ephemeralChats.snapshot('desktop-side')).toBeNull();
  });

  it('rejects malformed client structures without rejecting the handler or breaking a healthy peer', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    const malformed = ['{', 'null', '[]', '42', '{"type":"unknown"}',
      '{"type":"thread.watch","threadId":null,"additionalThreadIds":42}',
      JSON.stringify({ type: 'thread.watch', threadId: 'main', additionalThreadIds: Array(101).fill('side') }),
      '{"type":"sync.resume","threadId":null,"epoch":null,"after":-1}',
      '{"type":"rpc","id":"x","method":"not/allowed"}'];
    for (const raw of malformed) {
      await expect(hub.handleClientMessage(peer.socket, raw)).resolves.toBeUndefined();
      expect(peer.received.at(-1)).toMatchObject({ type: 'error' });
    }
    expect(hub.native).not.toHaveBeenCalled();
    await hub.send(peer.socket, { type: 'ping' });
    expect(peer.received.at(-1)).toMatchObject({ type: 'pong' });
  });
  it('isolates unexpected service failures and socket delivery errors', async () => {
    const hub = fixture(), peer = hub.peer();
    hub.connectClient(peer.socket);
    vi.spyOn(hub.eventJournal, 'resume').mockImplementation(() => { throw new Error('Synthetic service failure'); });
    await expect(hub.send(peer.socket, { type: 'sync.resume', epoch: null, after: 0, threadId: null }))
      .resolves.toBeUndefined();
    expect(peer.received.at(-1)).toMatchObject({ type: 'error' });
    peer.socket.send = () => { throw new Error('Synthetic closed socket'); };
    await expect(hub.send(peer.socket, { type: 'ping' })).resolves.toBeUndefined();
    expect(peer.socket.close).toHaveBeenCalled();
  });
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
