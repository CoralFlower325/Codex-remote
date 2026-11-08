import { describe, expect, it, vi } from 'vitest';
import { QueueDispatcher } from './queue-dispatcher.js';

describe('native follow-up dispatch', () => {
  it('waits for the active turn and consumes the same native queued id after completion', async () => {
    let active = true;
    let queued = true;
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/queue/list') return { data: queued ? [{ id: 'queued' }] : [] };
      if (method === 'thread/read') return { thread: { status: { type: active ? 'active' : 'idle' } } };
      if (method === 'thread/queue/start') { queued = false; active = true; }
      return {};
    });
    const queue = new QueueDispatcher(rpc as never);
    await queue.track('main');
    expect(rpc.mock.calls.some(([method]) => method === 'thread/queue/start')).toBe(false);
    active = false;
    await Promise.all([queue.drain('main'), queue.drain('main')]);
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/start')).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('thread/queue/start', { threadId: 'main', queuedSubmissionId: 'queued' });
  });

  it('does not lose a completion received while a native start is still returning', async () => {
    const ids = ['first', 'second'];
    let finishStart: (() => void) | undefined;
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/queue/list') return { data: ids.length ? [{ id: ids[0] }] : [] };
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      if (method === 'thread/queue/start') {
        if (ids.shift() === 'first') await new Promise<void>(resolve => { finishStart = resolve; });
      }
      return {};
    });
    const queue = new QueueDispatcher(rpc as never);
    const initial = queue.track('main');
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));
    void queue.drain('main');
    finishStart!();
    await initial;
    await vi.waitFor(() => expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/start')).toHaveLength(2));
  });

  it('reports failed queue reads and rechecks native state when the bridge recovers', async () => {
    let failed = true;
    let queued = true;
    const report = vi.fn();
    const rpc = vi.fn(async (method: string) => {
      if (failed) throw new Error('Disconnected');
      if (method === 'thread/queue/list') return { data: queued ? [{ id: 'pending' }] : [] };
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      if (method === 'thread/queue/start') queued = false;
      return {};
    });
    const queue = new QueueDispatcher(rpc as never, report);
    await queue.track('t');
    expect(report).toHaveBeenCalledOnce();
    expect(rpc.mock.calls.some(([method]) => method === 'thread/queue/start')).toBe(false);
    failed = false;
    await queue.recover();
    expect(rpc).toHaveBeenCalledWith('thread/queue/start', { threadId: 't', queuedSubmissionId: 'pending' });
  });

  it('does not replay a native queued submission consumed before its acknowledgement was lost', async () => {
    let queued = true;
    const report = vi.fn();
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/queue/list') return { data: queued ? [{ id: 'consumed' }] : [] };
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      if (method === 'thread/queue/start') { queued = false; throw new Error('Acknowledgement lost'); }
      return {};
    });
    const queue = new QueueDispatcher(rpc as never, report);
    await queue.track('t');
    await queue.recover();
    expect(report).toHaveBeenCalledOnce();
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/start')).toHaveLength(1);
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/queue/list')).toHaveLength(2);
  });
});
