import { describe, expect, it, vi } from 'vitest';
import { RemoteRequestRegistry } from './remote-request-registry';
import type { RemoteChannel } from './remote-connection';

function channel() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn()
  } as unknown as RemoteChannel;
}

describe('remote request registry', () => {
  it('resolves and rejects requests by server id', async () => {
    const registry = new RemoteRequestRegistry();
    const socket = channel();
    const success = registry.request<{ value: number }>(socket, 'thread/read', { threadId: 'synthetic' });
    const failure = registry.request(socket, 'thread/read', { threadId: 'synthetic' }).catch(error => error);
    const successId = JSON.parse(vi.mocked(socket.send).mock.calls[0]![0]).id as string;
    const failureId = JSON.parse(vi.mocked(socket.send).mock.calls[1]![0]).id as string;
    registry.resolve(successId, { value: 7 });
    registry.reject(failureId, Object.assign(new Error('synthetic failure'), { code: -32000 }));
    await expect(success).resolves.toEqual({ value: 7 });
    await expect(failure).resolves.toMatchObject({ message: 'synthetic failure', code: -32000 });
    expect(registry.size).toBe(0);
  });

  it('rejects a pending request on transport loss and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      const registry = new RemoteRequestRegistry();
      const pending = registry.request(channel(), 'thread/read', { threadId: 'synthetic' });
      registry.rejectAll(new Error('connection closed'));
      await expect(pending).rejects.toThrow('connection closed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
