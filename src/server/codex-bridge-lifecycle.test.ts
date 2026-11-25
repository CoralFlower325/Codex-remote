import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ config: {
  codexBinary: 'synthetic-codex',
  codexWorkdir: '/synthetic',
  appServerEndpointCandidates: ['/synthetic/app-server.json']
} }));

const mocked = vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return {
    bridge: Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => false),
      request: vi.fn(async (_method: string, _params: unknown) => ({})),
      shutdown: vi.fn(),
      getPendingServerRequests: vi.fn(() => []),
      respondToServerRequest: vi.fn(async () => {})
    })
  };
});

vi.mock('./app-server-bridge.js', async () => {
  const { bridge } = await mocked;
  return {
    AppServerBridge: class {
      constructor() { return bridge; }
    }
  };
});

import { CodexBridge } from './codex-bridge.js';

const appBridge = (await mocked).bridge;
let bridge: CodexBridge;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  appBridge.removeAllListeners();
  appBridge.connect.mockResolvedValue(false);
  bridge = new CodexBridge();
});

afterEach(() => {
  bridge.shutdown();
  vi.useRealTimers();
});

describe('shared App Server lifecycle', () => {
  it('stays offline without starting another App Server', async () => {
    await expect(bridge.ensureStarted()).rejects.toThrow('App Server');
    await expect(bridge.request('thread/resume', { threadId: 'synthetic' })).rejects.toThrow('App Server');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(bridge.getStatus()).toBe('offline');
    expect(bridge.getTransport()).toBe('desktop');
    expect(appBridge.request).not.toHaveBeenCalled();
  });

  it('recovers the owning transport without replaying a failed write', async () => {
    for (const method of ['turn/start', 'thread/archive'] as const) {
      await expect(bridge.request(method, { threadId: 'synthetic' })).rejects.toThrow('App Server');
    }
    appBridge.connect.mockImplementation(async () => {
      appBridge.emit('connected');
      return true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bridge.getStatus()).toBe('ready');
    expect(appBridge.request).not.toHaveBeenCalled();
    await bridge.request('thread/archive', { threadId: 'synthetic' });
    expect(appBridge.request).toHaveBeenCalledExactlyOnceWith(
      'thread/archive', { threadId: 'synthetic' });
  });

  it('keeps ready during a transient reconnect and marks persistent loss offline', async () => {
    appBridge.connect.mockResolvedValue(true);
    appBridge.emit('connected');
    const statuses: string[] = [];
    bridge.on('status', status => statuses.push(status));
    appBridge.emit('disconnected');
    await vi.advanceTimersByTimeAsync(100);
    expect(appBridge.connect).toHaveBeenCalledOnce();
    expect(bridge.getStatus()).toBe('ready');
    await vi.advanceTimersByTimeAsync(1_400);
    expect(bridge.getStatus()).toBe('offline');
    expect(statuses).toEqual(['offline']);
  });

  it('cancels reconnection on shutdown and rejects later requests', async () => {
    await expect(bridge.ensureStarted()).rejects.toThrow();
    bridge.shutdown();
    const attempts = appBridge.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(appBridge.connect).toHaveBeenCalledTimes(attempts);
    await expect(bridge.request('thread/read', {})).rejects.toThrow();
  });
});
