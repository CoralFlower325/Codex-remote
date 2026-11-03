import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ config: { codexBinary: 'synthetic-codex', codexWorkdir: '/synthetic' } }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => { throw new Error('A second backend must never start.'); }) }));
vi.mock('./desktop-bridge.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { desktopBridge: Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => false),
    request: vi.fn(async (_method: string, _params: unknown) => ({})),
    shutdown: vi.fn(),
    getPendingServerRequests: vi.fn(() => []),
    respondToServerRequest: vi.fn(async () => {})
  }) };
});

import { spawn } from 'node:child_process';
import { desktopBridge } from './desktop-bridge.js';
import { CodexBridge } from './codex-bridge.js';

let bridge: CodexBridge;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  desktopBridge.removeAllListeners();
  vi.mocked(desktopBridge.connect).mockResolvedValue(false);
  bridge = new CodexBridge();
});
afterEach(() => {
  bridge.shutdown();
  vi.useRealTimers();
});

describe('Desktop-owned backend lifecycle', () => {
  it('stays offline without creating an App Server when Desktop is unavailable', async () => {
    await expect(bridge.ensureStarted()).rejects.toThrow('Desktop');
    await expect(bridge.request('thread/resume', { threadId: 'synthetic' })).rejects.toThrow('Desktop');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(bridge.getStatus()).toBe('offline');
    expect(bridge.getTransport()).toBe('desktop');
    expect(desktopBridge.request).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('recovers the original Desktop transport without replaying a failed send or archive', async () => {
    for (const method of ['turn/start', 'thread/archive'] as const) {
      await expect(bridge.request(method, { threadId: 'synthetic' })).rejects.toThrow('Desktop');
    }
    vi.mocked(desktopBridge.connect).mockImplementation(async () => {
      desktopBridge.emit('connected');
      return true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bridge.getStatus()).toBe('ready');
    expect(desktopBridge.request).not.toHaveBeenCalled();
    await bridge.request('thread/archive', { threadId: 'synthetic' });
    expect(desktopBridge.request).toHaveBeenCalledExactlyOnceWith('thread/archive', { threadId: 'synthetic' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('marks a bridge loss offline and does not switch a send to another backend', async () => {
    vi.mocked(desktopBridge.connect).mockResolvedValue(true);
    desktopBridge.emit('connected');
    await bridge.request('thread/read', { threadId: 'synthetic' });
    desktopBridge.emit('disconnected');
    vi.mocked(desktopBridge.connect).mockResolvedValue(false);
    await expect(bridge.request('turn/start', { threadId: 'synthetic' })).rejects.toThrow('Desktop');
    expect(bridge.getStatus()).toBe('offline');
    expect(desktopBridge.request).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels reconnection on shutdown and rejects later requests', async () => {
    await expect(bridge.ensureStarted()).rejects.toThrow();
    bridge.shutdown();
    const attempts = vi.mocked(desktopBridge.connect).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(desktopBridge.connect).toHaveBeenCalledTimes(attempts);
    await expect(bridge.request('thread/read', {})).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
