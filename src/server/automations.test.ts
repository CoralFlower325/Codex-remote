import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Automations, type AutomationBridgeRequest } from './automations';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automations-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = new Date(2026, 10, 5, 9, 0, 0, 0).getTime();

function harness(options: { ready?: boolean; failWith?: unknown } = {}) {
  const dir = tempDir();
  let now = T0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request: AutomationBridgeRequest = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (options.failWith) throw options.failWith;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    return { turn: { id: 'turn-1' } };
  };
  const store = new Automations(dir, request, () => options.ready ?? true, () => now);
  return { dir, store, calls, setNow: (value: number) => { now = value; } };
}

describe('automations store and scheduler', () => {
  it('creates, validates and persists automations', () => {
    const { dir, store } = harness();
    const created = store.create({
      name: '晨间巡检', prompt: '检查待办', schedule: { kind: 'daily', time: '09:30' },
      projectId: 'p1', model: 'gpt-test', effort: 'high'
    });
    expect(created.nextRunAt).toBe(new Date(2026, 10, 5, 9, 30).getTime());
    expect(() => store.create({ name: '', prompt: 'x', schedule: { kind: 'daily', time: '09:30' } })).toThrow();
    expect(() => store.create({ name: 'x', prompt: 'x', schedule: { kind: 'daily', time: '25:00' } })).toThrow();
    const reloaded = new Automations(dir, async () => ({}), () => true, () => T0);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.name).toBe('晨间巡检');
  });

  it('dispatches a due automation through thread/start then turn/start and advances the schedule', async () => {
    const { store, calls, setNow } = harness();
    const created = store.create({ name: '巡检', prompt: '看看仓库状态', schedule: { kind: 'interval', everyMinutes: 30 } });
    expect(calls).toHaveLength(0);
    setNow(T0 + 31 * 60_000);
    await store.tick();
    expect(calls.map(call => call.method)).toEqual(['thread/start', 'turn/start']);
    expect(calls[1]?.params).toMatchObject({ threadId: 'thread-1' });
    expect((calls[1]?.params.input as Array<{ text: string }>)[0]?.text).toBe('看看仓库状态');
    const after = store.get(created.id)!;
    expect(after.lastThreadId).toBe('thread-1');
    expect(after.runs[0]).toMatchObject({ kind: 'scheduled', status: 'started' });
    expect(after.nextRunAt).toBe(T0 + 60 * 60_000);
  });

  it('collapses occurrences missed while offline into one run when the bridge returns', async () => {
    let ready = false;
    const dir = tempDir();
    let now = T0;
    const calls: string[] = [];
    const store = new Automations(dir, async method => {
      calls.push(method);
      return method === 'thread/start' ? { thread: { id: 't' } } : {};
    }, () => ready, () => now);
    const created = store.create({ name: '巡检', prompt: 'x', schedule: { kind: 'interval', everyMinutes: 30 } });
    now = T0 + 5 * 3_600_000; // Five hours offline: ten occurrences missed.
    await store.tick();
    expect(calls).toHaveLength(0);
    ready = true;
    await store.tick();
    expect(calls).toEqual(['thread/start', 'turn/start']);
    expect(store.get(created.id)?.nextRunAt).toBeGreaterThan(now);
    expect(store.get(created.id)?.runs).toHaveLength(1);
  });

  it('records definite rejections as failed and unprovable outcomes as unknown, without replaying', async () => {
    const rejected = harness({ failWith: Object.assign(new Error('bad model'), { code: -32602 }) });
    const a = rejected.store.create({ name: 'A', prompt: 'x', schedule: { kind: 'daily', time: '10:00' } });
    await rejected.store.runNow(a.id);
    expect(rejected.store.get(a.id)?.runs[0]?.status).toBe('failed');

    const dropped = harness({ failWith: new Error('socket closed') });
    const b = dropped.store.create({ name: 'B', prompt: 'x', schedule: { kind: 'daily', time: '10:00' } });
    await dropped.store.runNow(b.id);
    expect(dropped.store.get(b.id)?.runs[0]?.status).toBe('unknown');
    expect(dropped.calls).toHaveLength(1); // Exactly one attempt, never replayed.
  });

  it('pausing clears the next run and resuming recomputes it', () => {
    const { store } = harness();
    const created = store.create({ name: 'A', prompt: 'x', schedule: { kind: 'daily', time: '10:00' } });
    const paused = store.update(created.id, { status: 'paused' });
    expect(paused.nextRunAt).toBeNull();
    const resumed = store.update(created.id, { status: 'active' });
    expect(resumed.nextRunAt).toBe(new Date(2026, 10, 5, 10, 0).getTime());
  });
});
