import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Automations, type AutomationBridgeRequest } from './automations';
import type { Automation } from '../shared/automation-schedule';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))); });

const sample = (): Automation => ({
  id: 'native-1', kind: 'cron', name: 'Native task', prompt: 'Inspect project',
  status: 'ACTIVE', rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', model: 'synthetic',
  reasoningEffort: 'high', nextRunAt: 100000, lastRunAt: 90000,
  createdAt: 1, updatedAt: 2, target: { type: 'project', projectId: 'p1' },
  cwds: ['/one', '/two'], executionEnvironment: 'worktree',
  localEnvironmentConfigPath: '.codex/environment.toml', notificationPolicy: 'failed_runs_only', autoArchive: true
});

async function harness(items = [sample()], action?: AutomationBridgeRequest) {
  const request = vi.fn<AutomationBridgeRequest>(async (method, params) => {
    if (method === 'list') return { items };
    if (method === 'readHistory') return { items: [{
      automationId: 'native-1', threadId: 'run-1', status: 'PENDING_REVIEW',
      createdAt: 90000, archivedAssistantMessage: 'private archived body'
    }] };
    return action ? action(method, params) : { success: true, item: items[0] };
  });
  const app = express();
  app.use(express.json());
  const store = new Automations(request);
  app.use('/api/automations', store.router());
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const call = (path = '', method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${port}/api/automations${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { request, call, store };
}

describe('Desktop-owned automations', () => {
  it('reads native state and bounded history, omitting archived message bodies', async () => {
    const { call, request } = await harness();
    const response = await call();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.automations).toEqual([sample()]);
    expect(body.runs[0]).toEqual({
      automationId: 'native-1', threadId: 'run-1', status: 'PENDING_REVIEW', createdAt: 90000
    });
    expect(request.mock.calls.map(c => c[0])).toEqual(['list', 'readHistory']);
    expect(request).toHaveBeenCalledWith('readHistory', { limit: 200 });
  });

  it('creates through the native service without thread/start or turn/start', async () => {
    const { call, request } = await harness();
    const response = await call('', 'POST', {
      name: 'Task', prompt: 'Inspect', rrule: 'RRULE:FREQ=HOURLY;INTERVAL=3',
      status: 'PAUSED', projectId: 'p1', executionEnvironment: 'worktree', model: null, reasoningEffort: null,
      approvalPolicy: 'never'
    });
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith('create', {
      kind: 'cron', name: 'Task', prompt: 'Inspect', rrule: 'RRULE:FREQ=HOURLY;INTERVAL=3',
      status: 'PAUSED', projectId: 'p1', executionEnvironment: 'worktree', model: null, reasoningEffort: null
    });
  });

  it('preserves native target, environment, notification and auto-archive settings when pausing', async () => {
    const { call, request } = await harness();
    expect((await call('/native-1', 'PATCH', { status: 'PAUSED', updatedAt: 2 })).status).toBe(200);
    expect(request.mock.calls.at(-1)).toEqual(['update', {
      id: 'native-1', kind: 'cron', name: 'Native task', prompt: 'Inspect project',
      rrule: sample().rrule, status: 'PAUSED', model: 'synthetic', reasoningEffort: 'high',
      projectId: 'p1', executionEnvironment: 'worktree', notificationPolicy: 'failed_runs_only',
      localEnvironmentConfigPath: '.codex/environment.toml', autoArchive: true
    }]);
  });

  it('does not collapse legacy multi-root targets to roots[0]', async () => {
    const task = { ...sample(), target: null };
    const { call, request } = await harness([task]);
    await call('/native-1', 'PATCH', { status: 'PAUSED' });
    const params = request.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(params.cwds).toEqual(['/one', '/two']);
    expect(params).not.toHaveProperty('projectId');
  });

  it('retains heartbeat ownership and refuses to guess its live chat permissions for manual runs', async () => {
    const task: Automation = { ...sample(), kind: 'heartbeat', targetThreadId: 'chat-1' };
    const { call, request } = await harness([task]);
    await call('/native-1', 'PATCH', { status: 'PAUSED' });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'heartbeat', targetThreadId: 'chat-1' });
    const response = await call('/native-1/run', 'POST', {});
    expect(response.status).toBe(409);
    expect(request.mock.calls.some(c => c[0] === 'runNow')).toBe(false);
  });

  it('rejects stale edits without writing over Desktop changes', async () => {
    const { call, request } = await harness();
    expect((await call('/native-1', 'PATCH', { status: 'PAUSED', updatedAt: 1 })).status).toBe(409);
    expect(request.mock.calls.some(c => c[0] === 'update')).toBe(false);
  });

  it('never retries unknown actions after transport failure', async () => {
    const { call, request } = await harness([sample()], async () => { throw new Error('Outcome unknown'); });
    expect((await call('/native-1/run', 'POST', {})).status).toBe(502);
    expect(request.mock.calls.filter(c => c[0] === 'runNow')).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith('runNow', {
      id: 'native-1', collaborationMode: null, permissions: null
    });
  });

  it('serializes all mutations for one task', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const { call, request } = await harness([sample()], async () => { await held; return { success: true }; });
    const running = call('/native-1/run', 'POST', {});
    await vi.waitFor(() => expect(request.mock.calls.some(c => c[0] === 'runNow')).toBe(true));
    expect((await call('/native-1', 'DELETE', {})).status).toBe(409);
    release(); expect((await running).status).toBe(200);
  });

  it('validates native inputs before mutation and reports failed deletion', async () => {
    const { call, request } = await harness([sample()], async () => ({ success: false }));
    expect((await call('/native-1', 'PATCH', { rrule: 'invalid' })).status).toBe(400);
    expect(request.mock.calls.some(c => c[0] === 'update')).toBe(false);
    expect((await call('/native-1', 'DELETE', {})).status).toBe(502);
  });

  it('preserves unchanged native settings outside Remote editor limits', async () => {
    const native = { ...sample(), name: 'n'.repeat(100), prompt: 'p'.repeat(9000), rrule: 'future-native-rule' };
    const { call, request } = await harness([native]);
    expect((await call('/native-1', 'PATCH', { status: 'PAUSED' })).status).toBe(200);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      name: native.name, prompt: native.prompt, rrule: native.rrule
    });
  });

  it('treats a missing native write acknowledgement as unknown, without retry', async () => {
    const { call, request } = await harness([sample()], async () => ({}));
    expect((await call('/native-1', 'PATCH', { status: 'PAUSED' })).status).toBe(502);
    expect(request.mock.calls.filter(c => c[0] === 'update')).toHaveLength(1);
  });
});
