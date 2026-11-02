import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebUpdater } from './web-update.mjs';
import { readState, writeState, publicState } from './web-update-state.mjs';
import { serviceCommand, requireService, serviceControls } from './web-update-service.mjs';
import { runUpdate } from './web-update-worker.mjs';
import { acquireUpdateLock } from '../desktop/update-transaction.mjs';

const roots = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-web-update-test-'))); roots.push(root);
  for (const name of ['scripts', 'dist-server/server']) await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'codex-remote', version: '0.2.5' }));
  await fs.writeFile(path.join(root, 'dist-server/server/index.js'), 'old');
  for (const name of ['windows.ps1', 'macos.sh']) await fs.writeFile(path.join(root, 'scripts', `remote-control-${name}`), '');
  // Resolve real updater dependencies while keeping all mutations in the fixture.
  await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({
    tag_name: 'v0.2.6', body: 'Do not send notes over HTTP', assets: []
  }) }));
  const owned = vi.fn(async () => ({}));
  const launch = vi.fn(async () => null);
  const updater = createWebUpdater(root, { fetcher, owned, launch, platform: 'win32', arch: 'x64' });
  return { root, fetcher, owned, launch, updater };
}

describe('web backend update authority and durable state', () => {
  it('checks the installed host version, never exposing notes, paths or asset URLs', async () => {
    const f = await fixture();
    const offer = await f.updater.check();
    expect(offer).toMatchObject({ currentVersion: '0.2.5', latestVersion: '0.2.6', available: true, canUpdate: true });
    expect(JSON.stringify(offer)).not.toContain(f.root);
    expect(JSON.stringify(offer)).not.toContain('Do not send notes');
    expect(offer.token).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('makes current checks read only and declines unsupported hosts', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.2.5' }) });
    expect((await f.updater.check()).available).toBe(false);
    await expect(fs.access(path.join(f.root, 'output'))).rejects.toThrow();
    const unsupported = createWebUpdater(f.root, { platform: 'linux', arch: 'x64' });
    expect(await unsupported.check()).toMatchObject({ supported: false, available: false });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('requires a checked offer, fresh ownership and the same official latest version', async () => {
    const f = await fixture();
    const offer = await f.updater.check();
    const request = { id: crypto.randomUUID(), token: offer.token, version: '0.2.6' };
    await expect(f.updater.start({ ...request, token: crypto.randomUUID() })).rejects.toThrow('失效');
    f.owned.mockRejectedValueOnce(new Error('service changed'));
    await expect(f.updater.start(request)).rejects.toThrow('service changed');
    f.fetcher.mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.2.7' }) });
    await expect(f.updater.start(request)).rejects.toThrow('最新版本已变化');
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('snapshots executable dependencies outside the replaceable installation before launching exactly once', async () => {
    const f = await fixture();
    const offer = await f.updater.check();
    const request = { id: crypto.randomUUID(), token: offer.token, version: '0.2.6' };
    const first = await f.updater.start(request);
    const again = await f.updater.start(request);
    expect(first.id).toBe(again.id); expect(f.launch).toHaveBeenCalledOnce();
    const job = f.launch.mock.calls[0][0];
    await fs.access(path.join(job, 'node_modules/tar/package.json'));
    await fs.access(path.join(job, 'node_modules/undici/package.json'));
    const worker = await import(pathToFileURL(path.join(job, 'scripts/web-update-worker.mjs')).href);
    expect(typeof worker.runUpdate).toBe('function');
    expect(await fs.readFile(path.join(f.root, 'dist-server/server/index.js'), 'utf8')).toBe('old');
    await expect(f.updater.start({ ...request, id: crypto.randomUUID() })).rejects.toThrow('已有');
  }, 30_000);
  it('keeps an uncertain launch discoverable without launching a second worker', async () => {
    const f = await fixture(); const offer = await f.updater.check();
    f.launch.mockRejectedValue(new Error('launch failed'));
    await expect(f.updater.start({ id: crypto.randomUUID(), token: offer.token, version: '0.2.6' })).rejects.toThrow('launch failed');
    const state = await readState(f.root);
    expect((await f.updater.status(state.id)).operation.status).toBe('running');
    await writeState(f.root, { ...state, updatedAt: Date.now() - 31_000 });
    expect((await f.updater.status(state.id)).operation.status).toBe('interrupted');
    await f.updater.start({ id: state.id, token: offer.token, version: '0.2.6' });
    expect(f.launch).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(f.root, 'dist-server/server/index.js'), 'utf8')).toBe('old');
  }, 30_000);
  it('persists the job before release preparation, including preparation failure', async () => {
    const f = await fixture(), offer = await f.updater.check(), id = crypto.randomUUID();
    let reject;
    f.fetcher.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockRejectedValueOnce(new Error('ETIMEDOUT private-fallback-host'));
    const started = f.updater.start({ id, token: offer.token, version: '0.2.6' });
    const failed = expect(started).rejects.toThrow('ETIMEDOUT');
    await vi.waitFor(async () => expect((await f.updater.status(id)).operation).toMatchObject({
      id, status: 'running', progress: { step: 'launch', percent: 0 }
    }));
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    reject(new Error('ETIMEDOUT private-host'));
    await failed;
    const result = (await f.updater.status(id)).operation;
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('private-host');
    expect(f.launch).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.root, 'dist-server/server/index.js'), 'utf8')).toBe('old');
  });
  it('reads exact jobs after another job becomes active and preserves old-worker compatibility', async () => {
    const f = await fixture(), first = crypto.randomUUID(), second = crypto.randomUUID();
    const state = { root: f.root, version: '0.2.6', fromVersion: '0.2.5', pid: null,
      updatedAt: Date.now(), progress: null };
    await writeState(f.root, { ...state, id: first, status: 'completed' });
    await writeState(f.root, { ...state, id: second, status: 'running' });
    expect((await f.updater.status()).operation.id).toBe(second);
    expect((await f.updater.status(first)).operation).toMatchObject({ id: first, status: 'completed' });
    expect((await f.updater.status(crypto.randomUUID())).operation).toBeNull();
    // Repeating an older idempotency ID cannot replace the current active job.
    expect((await f.updater.start({ id: first })).status).toBe('completed');
    expect((await readState(f.root)).id).toBe(second);
    await fs.rm(path.join(f.root, 'output/web-update', `${second}.json`));
    expect((await readState(f.root, second)).id).toBe(second);
    await expect(readState(f.root, '../outside')).rejects.toThrow('无效');
  });
  it('retains actual progress across controller restarts and strips private diagnostics', async () => {
    const f = await fixture();
    await writeState(f.root, { id: crypto.randomUUID(), root: f.root, version: '0.2.6', fromVersion: '0.2.5',
      status: 'running', pid: process.pid, updatedAt: Date.now(),
      progress: { percent: 88, step: 'install', title: '安装新版本', detail: `${f.root}/private`,
        logs: [{ message: 'private diagnostic' }] } });
    const restarted = createWebUpdater(f.root);
    const value = await restarted.status();
    expect(value.operation.progress).toMatchObject({ percent: 88, step: 'install' });
    expect(JSON.stringify(value)).not.toContain(f.root);
    expect(JSON.stringify(value)).not.toContain('private');
    const interrupted = publicState({ ...await readState(f.root), pid: null, updatedAt: Date.now() - 31_000 });
    expect(interrupted.status).toBe('interrupted');
  });
});

describe('independent worker transaction', () => {
  it('serializes first worker PID publication with a competing start', async () => {
    const f = await fixture(), offer = await f.updater.check(), id = crypto.randomUUID();
    const rename = fs.rename.bind(fs);
    let releaseWrite, paused = false;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!paused && to === path.join(f.root, 'output/web-update', `${id}.json`)) {
        paused = true; await writeGate;
      }
      return rename(from, to);
    });
    const worker = runUpdate({ id, root: f.root, version: '0.2.6', fromVersion: '0.2.5',
      backendPid: process.pid, release: {} }, {
      owned: async () => {}, controls: () => ({}), prepare: async () => ({}), install: async () => {}
    });
    await vi.waitFor(() => expect(paused).toBe(true));
    try {
      await expect(f.updater.start({ id: crypto.randomUUID(), token: offer.token, version: '0.2.6' }))
        .rejects.toThrow('另一个管理器');
      expect(f.launch).not.toHaveBeenCalled();
    } finally { releaseWrite(); }
    expect((await worker).status).toBe('completed');
    expect((await readState(f.root)).id).toBe(id);
    const release = await acquireUpdateLock(f.root);
    await release();
  });
  it('releases the claim lock after a first state write failure', async () => {
    const f = await fixture(), id = crypto.randomUUID(), rename = fs.rename.bind(fs), prepare = vi.fn();
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => to.endsWith(`${id}.json`)
      ? Promise.reject(new Error('injected claim write failure')) : rename(from, to));
    await expect(runUpdate({ id, root: f.root, version: '0.2.6', backendPid: process.pid }, { prepare }))
      .rejects.toThrow('injected claim write failure');
    expect(prepare).not.toHaveBeenCalled();
    const release = await acquireUpdateLock(f.root);
    await release();
  });
  it('recovers from a transient state write failure before continuing the worker', async () => {
    const f = await fixture(), id = crypto.randomUUID(), rename = fs.rename.bind(fs);
    let failures = 0;
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (to.endsWith(`${id}.json`) && failures === 0) {
        failures++;
        return Promise.reject(Object.assign(new Error('transient state write failure'), { code: 'EBUSY' }));
      }
      return rename(from, to);
    });
    const result = await runUpdate({ id, root: f.root, version: '0.2.6', fromVersion: '0.2.5',
      backendPid: process.pid, release: {} }, {
      owned: async () => {}, controls: () => ({}),
      prepare: async () => ({}), install: async () => {}
    });
    expect(result.status).toBe('completed');
    expect(failures).toBe(1);
    expect((await readState(f.root, id)).status).toBe('completed');
  });
  it('lets a later progress snapshot recover after one snapshot exhausts its write retries', async () => {
    const f = await fixture(), id = crypto.randomUUID(), rename = fs.rename.bind(fs);
    let failWrites = false, failures = 0;
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (failWrites && to.endsWith(`${id}.json`)) {
        failures++;
        return Promise.reject(Object.assign(new Error('temporary state write failure'), { code: 'EBUSY' }));
      }
      return rename(from, to);
    });
    const result = await runUpdate({ id, root: f.root, version: '0.2.6', fromVersion: '0.2.5',
      backendPid: process.pid, release: {} }, {
      owned: async () => {}, controls: () => ({}),
      prepare: async (_root, _release, progress) => {
        failWrites = true;
        progress('first snapshot', { step: 'runtime', percent: 10 });
        await vi.waitFor(() => expect(failures).toBe(3));
        failWrites = false;
        progress('next snapshot', { step: 'unpack', percent: 20 });
        return {};
      },
      install: async () => {}
    });
    expect(result.status).toBe('completed');
    expect((await readState(f.root, id))).toMatchObject({
      status: 'completed', progress: { step: 'unpack', percent: 20 }
    });
  });
  it('refuses a late or superseded worker before ownership checks or mutations', async () => {
    const f = await fixture(), id = crypto.randomUUID(), owned = vi.fn(), prepare = vi.fn();
    const request = { id, root: f.root, version: '0.2.6', backendPid: process.pid };
    const state = { ...request, fromVersion: '0.2.5', pid: null, progress: null,
      updatedAt: Date.now() - 31_000, status: 'running' };
    await writeState(f.root, state);
    await expect(runUpdate(request, { owned, prepare })).rejects.toThrow('已结束');
    await writeState(f.root, { ...state, id: crypto.randomUUID(), updatedAt: Date.now() });
    await expect(runUpdate(request, { owned, prepare })).rejects.toThrow('已结束');
    expect(owned).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it('persists a heartbeat during quiet preparation without inventing progress', async () => {
    const f = await fixture(), id = crypto.randomUUID();
    let complete;
    const preparation = new Promise(resolve => { complete = resolve; });
    const prepare = vi.fn(() => preparation);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const result = runUpdate({ id, root: f.root, version: '0.2.6', fromVersion: '0.2.5',
      backendPid: process.pid, release: {} }, {
      owned: async () => {}, controls: () => ({}),
      prepare, install: async () => {}
    });
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce(), { timeout: 5000 });
      const before = await readState(f.root);
      await vi.advanceTimersByTimeAsync(5000);
      // Advancing fake timers does not flush the two real filesystem records.
      await vi.waitFor(async () => expect((await readState(f.root)).updatedAt)
        .toBeGreaterThan(before.updatedAt), { timeout: 5000 });
      expect((await readState(f.root)).progress).toBeNull();
    } finally {
      complete({});
      await result;
    }
    expect((await result).status).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
  }, 20_000);
  it('prepares before stopping and reports completion only after verification returns', async () => {
    const f = await fixture(), calls = [];
    const request = { id: crypto.randomUUID(), root: f.root, version: '0.2.6', fromVersion: '0.2.5',
      backendPid: process.pid, release: { version: '0.2.6' } };
    const result = await runUpdate(request, {
      owned: async () => calls.push('owned'),
      prepare: async () => { calls.push('prepare'); return {}; },
      controls: () => ({
        stop: async () => {
          expect((await readState(f.root)).status).toBe('running'); calls.push('stop');
        },
        start: async () => calls.push('start'), verify: async () => calls.push('verify')
      }),
      install: async (_prepared, actions) => {
        await actions.stop(); await actions.start(); await actions.verify();
        expect((await readState(f.root)).status).toBe('running');
      }
    });
    expect(result.status).toBe('completed');
    expect((await readState(f.root)).status).toBe('completed');
    expect(calls).toEqual(['owned', 'prepare', 'owned', 'stop', 'start', 'verify']);
  });
  it('keeps the operation running while rollback still owns the service', async () => {
    const f = await fixture();
    const result = await runUpdate({ id: crypto.randomUUID(), root: f.root, version: '0.2.6',
      fromVersion: '0.2.5', backendPid: process.pid, release: {} }, {
      owned: async () => {}, prepare: async () => ({}), controls: () => ({}),
      install: async (_prepared, { progress }) => {
        progress('恢复旧版', { status: 'recovered', percent: 100, step: 'restore-service' });
        await vi.waitFor(async () => expect((await readState(f.root)).progress.status).toBe('recovered'));
        expect((await readState(f.root)).status).toBe('running');
        throw new Error('install failed');
      }
    });
    expect(result.status).toBe('recovered');
  });
  it('does not stop the backend on a preparation or ownership failure', async () => {
    const f = await fixture(); const stop = vi.fn();
    const result = await runUpdate({ id: crypto.randomUUID(), root: f.root, version: '0.2.6',
      fromVersion: '0.2.5', backendPid: process.pid, release: {} }, {
      owned: async () => {}, prepare: async () => { throw new Error('ECONNRESET'); },
      controls: () => ({ stop })
    });
    expect(stop).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.message).toContain('网络');
  });
});

describe('backend-only platform controls', () => {
  it.each(['win32', 'darwin'])('uses only the selected backend service on %s', platform => {
    const [file, args] = serviceCommand('/installation', 'Stop', platform);
    expect(file).toBe(platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    expect(args.join(' ')).toContain('web-update-service-');
    expect(args).toContain('/installation'); expect(args).toContain('Stop');
    expect(args.join(' ')).not.toContain('remote-control-');
  });
  it('rejects an unmanaged listener before a worker can mutate files', async () => {
    await expect(requireService('/installation', 123, async () =>
      JSON.stringify({ installed: true, enabled: true, running: true, conflict: false, pids: [456] }), 'win32')).rejects.toThrow('系统服务');
  });
});
