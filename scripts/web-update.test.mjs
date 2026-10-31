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

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-web-update-test-')); roots.push(root);
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
  it('keeps the old installation on an independent-worker launch failure', async () => {
    const f = await fixture(); const offer = await f.updater.check();
    f.launch.mockRejectedValue(new Error('launch failed'));
    await expect(f.updater.start({ id: crypto.randomUUID(), token: offer.token, version: '0.2.6' })).rejects.toThrow('launch failed');
    expect((await f.updater.status()).operation.status).toBe('failed');
    expect(await fs.readFile(path.join(f.root, 'dist-server/server/index.js'), 'utf8')).toBe('old');
  }, 30_000);
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
      JSON.stringify({ installed: true, enabled: true, running: true, conflict: false, pids: [456] }))).rejects.toThrow('系统服务');
  });
});
