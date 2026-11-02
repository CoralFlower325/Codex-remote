import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ServerMessage } from '../shared/protocol';
import { RemoteConnection, type RemoteChannel } from './remote-connection';
import { hostNow, synchronizeHostClock } from './host-clock';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  constructor(readonly url: string) { super(); FakeEventSource.instances.push(this); }
  close = vi.fn();
  open() { this.dispatchEvent(new Event('open')); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

describe('Remote connection recovery', () => {
  let browser: EventTarget;
  let documentTarget: EventTarget & { visibilityState: string };
  let network: { onLine: boolean };
  let connection: RemoteConnection;
  let onDisconnect: Mock<(error: Error) => void>;
  let onMessage: Mock<(message: ServerMessage) => void>;
  let onOpen: Mock<() => void>;
  let current: RemoteChannel | null;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    FakeEventSource.instances = [];
    browser = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
    documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    network = { onLine: true };
    vi.stubGlobal('window', browser);
    vi.stubGlobal('document', documentTarget);
    vi.stubGlobal('navigator', network);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
    onDisconnect = vi.fn<(error: Error) => void>();
    onMessage = vi.fn<(message: ServerMessage) => void>();
    onOpen = vi.fn<() => void>();
    current = null;
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws',
      onSocket: (socket) => { current = socket; },
      onOpen, onMessage, onDisconnect
    });
    connection.start();
  });

  afterEach(() => {
    connection.dispose();
    synchronizeHostClock(Date.now(), Date.now(), Date.now());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('replaces an OPEN socket when heartbeats stop returning', () => {
    const first = FakeSocket.instances[0]!;
    first.open();
    first.message({ type: 'pong', at: 'now' });
    vi.advanceTimersByTime(25_000);
    expect(first.sent).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(current).toBeNull();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(3);
  });

  it('uses host time despite a five-minute browser clock error and rechecks it after reconnecting', () => {
    vi.setSystemTime(500_000);
    const first = FakeSocket.instances[0]!;
    first.open();
    vi.advanceTimersByTime(200);
    first.message({ type: 'pong', at: new Date(200_100).toISOString() });
    expect(hostNow()).toBe(200_200);
    vi.advanceTimersByTime(1000);
    expect(hostNow()).toBe(201_200);
    connection.reconnect();
    const second = FakeSocket.instances[1]!;
    second.open();
    vi.advanceTimersByTime(100);
    second.message({ type: 'pong', at: new Date(201_250).toISOString() });
    expect(hostNow()).toBe(201_300);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('times out a stalled handshake and ignores late events from it', () => {
    const first = FakeSocket.instances[0]!;
    vi.advanceTimersByTime(6250);
    const second = FakeSocket.instances[1]!;
    second.open();
    first.open();
    first.message({ type: 'event', method: 'stale', params: {} });
    first.close();
    expect(current).toBe(second);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('refreshes the heartbeat deadline when returning to the foreground', () => {
    const first = FakeSocket.instances[0]!;
    first.open();
    first.message({ type: 'pong', at: 'now' });
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(first.sent).toHaveLength(1);
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(first.sent).toHaveLength(2);
    vi.advanceTimersByTime(29_999);
    expect(onDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('treats regular server messages as heartbeat liveness', () => {
    const first = FakeSocket.instances[0]!;
    first.open();
    first.message({ type: 'pong', at: 'now' });
    vi.advanceTimersByTime(20_000);
    first.message({ type: 'event', method: 'thread/list/updated', params: {} });
    vi.advanceTimersByTime(20_000);
    expect(onDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(first.sent).toHaveLength(2);
  });

  it('waits while offline and reconnects immediately when the network returns', () => {
    FakeSocket.instances[0]!.open();
    network.onLine = false;
    browser.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    network.onLine = true;
    browser.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    browser.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('reconnects on errors and never retries or delivers events after disposal', () => {
    const first = FakeSocket.instances[0]!;
    first.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    connection.dispose();
    second.message({ type: 'pong', at: 'late' });
    browser.dispatchEvent(new Event('online'));
    browser.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(current).toBeNull();
    expect(onMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a stalled transport within six seconds without a manual reconnect', () => {
    const first = FakeSocket.instances[0]!;
    vi.advanceTimersByTime(5999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(first.readyState).toBe(3);
    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('bounds synchronization separately from the browser opening the socket', () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', readyType: 'sync.ready', heartbeatIntervalMs: 5000, pongTimeoutMs: 12_000,
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    const first = FakeSocket.instances.at(-1)!;
    first.open();
    first.message({ type: 'pong', at: 'now' });
    vi.advanceTimersByTime(6000);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onDisconnect.mock.calls[0]![0].message).toContain('synchronization');
    vi.advanceTimersByTime(250);
    const second = FakeSocket.instances.at(-1)!;
    second.open();
    second.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: false });
    second.message({ type: 'pong', at: 'now' });
    vi.advanceTimersByTime(6000);
    expect(current).toBe(second);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(second.sent).toEqual([JSON.stringify({ type: 'ping' }), JSON.stringify({ type: 'ping' })]);
  });

  it('does not grow visible reconnect waits beyond five seconds or replay actions', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const socket = FakeSocket.instances.at(-1)!;
      socket.dispatchEvent(new Event('error'));
      vi.advanceTimersByTime(Math.min(250 * 2 ** attempt, 5000));
      expect(FakeSocket.instances).toHaveLength(attempt + 2);
    }
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    expect(FakeSocket.instances.slice(0, -1).every(socket => socket.sent.length === 0)).toBe(true);
  });

  it('gives an unfinished handshake a fresh full deadline after a real background suspension', () => {
    const first = FakeSocket.instances[0]!;
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(20_000);
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(first.readyState).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(5999);
    expect(onDisconnect).not.toHaveBeenCalled();
    first.open();
    expect(current).toBe(first);
  });

  it('does not cut a still-connecting HTTP channel to two seconds on focus or pageshow', async () => {
    connection.dispose();
    vi.stubGlobal('sessionStorage', { getItem: () => '1', setItem: vi.fn() });
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection', readyType: 'sync.ready',
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    const stream = FakeEventSource.instances[0]!;
    await vi.advanceTimersByTimeAsync(2500);
    browser.dispatchEvent(new Event('focus'));
    browser.dispatchEvent(new Event('pageshow'));
    expect(stream.close).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    stream.open();
    stream.message({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(7000);
    stream.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: false });
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('keeps the original transport deadline when an early focus event occurs', () => {
    vi.advanceTimersByTime(1500);
    browser.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(4499);
    expect(onDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onDisconnect.mock.calls[0]![0].message).toContain('connection timed out');
  });

  it('keeps the HTTP synchronization budget at twelve seconds after ordinary focus', async () => {
    connection.dispose();
    vi.stubGlobal('sessionStorage', { getItem: () => '1', setItem: vi.fn() });
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection', readyType: 'sync.ready',
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    const stream = FakeEventSource.instances[0]!;
    stream.open();
    stream.message({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(4000);
    browser.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(7000);
    expect(onDisconnect).not.toHaveBeenCalled();
    stream.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('does not postpone synchronization indefinitely on repeated focus events', () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', readyType: 'sync.ready',
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    FakeSocket.instances.at(-1)!.open();
    FakeSocket.instances.at(-1)!.message({ type: 'pong' });
    for (let second = 0; second < 5; second++) {
      vi.advanceTimersByTime(1000);
      browser.dispatchEvent(new Event('focus'));
    }
    vi.advanceTimersByTime(1000);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onDisconnect.mock.calls[0]![0].message).toContain('synchronization');
  });

  it('does not tear down a synchronized connection for a redundant online event', () => {
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.message({ type: 'pong' });
    browser.dispatchEvent(new Event('online'));
    expect(current).toBe(socket);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('keeps a new handshake during early focus and manually reconnects without waiting or replay', () => {
    browser.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1999);
    browser.dispatchEvent(new Event('focus'));
    expect(FakeSocket.instances).toHaveLength(1);
    connection.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(2);
    connection.dispose();
    connection.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('switches a rejected WebSocket to HTTP, completes sync and sends each action once', async () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection', readyType: 'sync.ready',
      heartbeatIntervalMs: 5000, pongTimeoutMs: 12_000,
      onSocket: socket => { current = socket; },
      onOpen: () => current!.send('{"type":"sync.resume"}'), onMessage, onDisconnect
    });
    connection.start();
    FakeSocket.instances.at(-1)!.dispatchEvent(new Event('error'));
    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = FakeEventSource.instances[0]!;
    stream.open();
    stream.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: false });
    stream.message({ type: 'pong' });
    current!.send('{"type":"rpc","method":"turn/start","id":"one"}');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => String(init?.body).includes('turn/start'))).toHaveLength(1);
    expect(sessionStorage.setItem).toHaveBeenCalledWith('remote-http-transport', '1');
    expect(FakeSocket.instances).toHaveLength(2);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sync.ready' }));
    connection.dispose();
    expect(stream.close).toHaveBeenCalled();
  });

  it('warms HTTP while WebSocket connects and isolates a failed action POST', async () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection',
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = FakeEventSource.instances[0]!;
    stream.open();
    stream.message({ type: 'pong' });
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network lost'));
    current!.send('{"type":"rpc","method":"turn/start","id":"one"}');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => String(init?.body).includes('turn/start'))).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(current!.readyState).toBe(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'rpc.error', id: 'one' }));
  });

  it('uses a warmed HTTP connection before the WebSocket deadline without reporting a disconnect', async () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection', readyType: 'sync.ready',
      heartbeatIntervalMs: 5000, pongTimeoutMs: 12_000,
      onSocket: socket => { current = socket; },
      onOpen: () => current!.send('{"type":"sync.resume"}'), onMessage, onDisconnect
    });
    connection.start();
    const primary = FakeSocket.instances.at(-1)!;
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = FakeEventSource.instances[0]!;
    stream.open();
    stream.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: false });
    stream.message({ type: 'pong' });
    expect(primary.readyState).toBe(3);
    expect(current!.readyState).toBe(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    primary.open();
    primary.message({ type: 'event', method: 'stale', params: {} });
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'stale' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => String(init?.body).includes('sync.resume'))).toHaveLength(1);
  });

  it('keeps the WebSocket if it opens first and releases the unused warm HTTP peer', async () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection',
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(500);
    const stream = FakeEventSource.instances[0]!;
    const primary = FakeSocket.instances.at(-1)!;
    primary.open();
    primary.message({ type: 'pong' });
    stream.open();
    expect(current).toBe(primary);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('reuses the warm HTTP peer when WebSocket fails and closes both pending candidates on disposal', async () => {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection',
      onSocket: socket => { current = socket; }, onOpen, onMessage, onDisconnect
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(500);
    FakeSocket.instances.at(-1)!.dispatchEvent(new Event('error'));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(current!.readyState).toBe(0);
    connection.dispose();
    expect(FakeEventSource.instances[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('keeps a suspended phone connection and gives it a fresh heartbeat on return', () => {
    const socket = FakeSocket.instances[0]!;
    socket.open();
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120_000);
    expect(onDisconnect).not.toHaveBeenCalled();
    documentTarget.visibilityState = 'visible';
    browser.dispatchEvent(new Event('pageshow'));
    socket.message({ type: 'pong' });
    vi.advanceTimersByTime(11_000);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('does not disconnect for a seven-second mobile heartbeat round trip', () => {
    const socket = FakeSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(7000);
    socket.message({ type: 'pong' });
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(current).toBe(socket);
  });

  function startWithFallback() {
    connection.dispose();
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', httpFallback: '/api/connection', readyType: 'sync.ready',
      heartbeatIntervalMs: 5000, pongTimeoutMs: 12_000,
      onSocket: socket => { current = socket; },
      onOpen: () => current!.send('{"type":"sync.resume"}'), onMessage, onDisconnect
    });
    connection.start();
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    socket.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: false });
    socket.message({ type: 'pong' });
    return socket;
  }

  it('verifies a new route in parallel and resumes without replaying model actions', async () => {
    const socket = startWithFallback();
    current!.send('{"type":"rpc","method":"turn/start","id":"once"}');
    await vi.advanceTimersByTimeAsync(7000);
    const replacement = FakeEventSource.instances.at(-1)!;
    expect(replacement).toBeDefined();
    replacement.open();
    await vi.advanceTimersByTimeAsync(1);
    expect(current).toBe(socket);
    expect(onDisconnect).not.toHaveBeenCalled();
    replacement.message({ type: 'pong' });
    expect(socket.readyState).toBe(3);
    expect(current!.readyState).toBe(1);
    replacement.message({ type: 'sync.ready', epoch: 'test', sequence: 0, resumed: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sync.ready', resumed: true }));
    expect(socket.sent.filter(raw => raw.includes('turn/start'))).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => String(init?.body).includes('turn/start'))).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('keeps a slow original connection when its pong wins the recovery probe', async () => {
    const socket = startWithFallback();
    await vi.advanceTimersByTimeAsync(7000);
    const replacement = FakeEventSource.instances.at(-1)!;
    replacement.open();
    socket.message({ type: 'pong' });
    replacement.message({ type: 'pong' });
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(current).toBe(socket);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('does not let a failed replacement tear down the original or reset its deadline', async () => {
    const socket = startWithFallback();
    await vi.advanceTimersByTimeAsync(7000);
    FakeEventSource.instances.at(-1)!.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(9000);
    expect(current).toBe(socket);
    expect(onDisconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('cancels probes while hidden and releases their timers and peers on disposal', async () => {
    startWithFallback();
    await vi.advanceTimersByTimeAsync(7000);
    const replacement = FakeEventSource.instances.at(-1)!;
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(replacement.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDisconnect).not.toHaveBeenCalled();
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('probes immediately on a browser connection change without replacing a healthy socket', () => {
    connection.dispose();
    const networkInfo = new EventTarget();
    vi.stubGlobal('navigator', { onLine: true, connection: networkInfo });
    connection = new RemoteConnection({
      url: 'wss://remote.test/ws', onSocket: socket => { current = socket; },
      onOpen, onMessage, onDisconnect
    });
    connection.start();
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    socket.message({ type: 'pong' });
    networkInfo.dispatchEvent(new Event('change'));
    expect(socket.sent).toHaveLength(2);
    socket.message({ type: 'pong' });
    expect(current).toBe(socket);
    expect(onDisconnect).not.toHaveBeenCalled();
    connection.dispose();
    networkInfo.dispatchEvent(new Event('change'));
    expect(socket.sent).toHaveLength(2);
  });
});
