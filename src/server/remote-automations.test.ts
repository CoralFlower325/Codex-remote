import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteAutomations } from './remote-automations.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('shared App Server automations', () => {
  it('persists task definitions and starts them through the owning App Server', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-automations-'));
    const rpc = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: 'scheduled-thread' } }
      : { turn: { id: 'turn-1' } });
    const service = new RemoteAutomations(directory, rpc);
    cleanup.push(async () => {
      service.shutdown();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const created = await service.request('create', {
      kind: 'cron',
      name: 'Daily check',
      prompt: 'Check the service',
      status: 'ACTIVE',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      model: null,
      reasoningEffort: null,
      target: { type: 'project', projectId: 'project-1' },
      cwds: [directory]
    }) as { item: { id: string; nextRunAt: number | null } };
    expect(created.item.nextRunAt).toEqual(expect.any(Number));
    expect(await service.request('list')).toMatchObject({ items: [{ id: created.item.id }] });
    await expect(service.request('runNow', { id: created.item.id })).resolves.toMatchObject({
      success: true,
      threadId: 'scheduled-thread'
    });
    expect(rpc).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      cwd: directory,
      projectId: 'project-1'
    }));
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'scheduled-thread',
      input: [{ type: 'text', text: 'Check the service' }]
    }));
    expect(await service.request('readHistory', { limit: 10 })).toMatchObject({
      items: [{ automationId: created.item.id, threadId: 'scheduled-thread', status: 'started' }]
    });
  });

  it('resumes an existing heartbeat thread before starting its turn', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-heartbeat-'));
    const rpc = vi.fn(async () => ({}));
    const service = new RemoteAutomations(directory, rpc);
    cleanup.push(async () => {
      service.shutdown();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const created = await service.request('create', {
      kind: 'heartbeat',
      name: 'Heartbeat',
      prompt: 'Check again',
      status: 'PAUSED',
      rrule: 'FREQ=HOURLY;BYMINUTE=0;BYSECOND=0',
      model: null,
      reasoningEffort: null,
      target: null,
      targetThreadId: 'existing-thread'
    }) as { item: { id: string } };
    await service.request('runNow', { id: created.item.id });
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/resume',
      'turn/start'
    ]);
    expect(rpc).toHaveBeenCalledWith('thread/resume', { threadId: 'existing-thread' });
  });

  it('records a durable failed claim without replaying the write', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-failure-'));
    const rpc = vi.fn(async () => {
      throw new Error('synthetic write failure');
    });
    const service = new RemoteAutomations(directory, rpc);
    cleanup.push(async () => {
      service.shutdown();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const created = await service.request('create', {
      kind: 'heartbeat',
      name: 'Heartbeat',
      prompt: 'Check again',
      status: 'PAUSED',
      rrule: 'FREQ=HOURLY;BYMINUTE=0;BYSECOND=0',
      model: null,
      reasoningEffort: null,
      target: null,
      targetThreadId: 'existing-thread'
    }) as { item: { id: string } };
    await expect(service.request('runNow', { id: created.item.id }))
      .rejects.toThrow('synthetic write failure');
    expect(await service.request('readHistory', { limit: 10 })).toMatchObject({
      items: [{ automationId: created.item.id, status: 'failed: synthetic write failure' }]
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });
});
