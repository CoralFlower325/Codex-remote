import { describe, it, expect, vi } from 'vitest';
import { controlCommand, summarize, probe, serviceStatus, externalEntry, health, diagnostics, startupReady, publicDiagnosis } from './controller.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from './process.mjs';
import net from 'node:net';
import { portListening } from './controller.mjs';

describe('local manager control boundary', () => {
  it('uses argument arrays and the selected checkout on both platforms', () => {
    const root = 'folder with spaces; literal';
    expect(controlCommand('win32', root, 'Start')[1]).toContain('-NoBrowser');
    expect(controlCommand('darwin', root, 'Status')[1]).toEqual([
      expect.stringContaining(root), 'Status', '--json'
    ]);
    expect(() => controlCommand('darwin', root, 'Start; rm')).toThrow();
    expect(() => controlCommand('linux', root, 'Start')).toThrow();
  });
  it('requires owned backend, Desktop, password and managed tunnel readiness', () => {
    const service = { running: true, tunnelManaged: true };
    const local = { reachable: true, body: { ok: true, codex: 'ready', transport: 'desktop', passwordConfigured: true } };
    expect(summarize(service, local, { reachable: true })).toBe('healthy');
    expect(summarize(service, local, { reachable: false })).toBe('degraded');
    expect(summarize(service, { ...local, body: { ...local.body, transport: 'standalone' } }, { reachable: true })).toBe('degraded');
    expect(summarize({ running: false }, local, {})).toBe('unowned');
    expect(summarize({ conflict: true }, local, {})).toBe('conflict');
    expect(summarize({ running: true }, { reachable: false }, {})).toBe('degraded');
    expect(summarize({ running: false }, { reachable: false }, {})).toBe('stopped');
    expect(summarize({ running: false }, { reachable: false, listening: true }, {})).toBe('unowned');
  });
  it('detects a port owner even when it does not serve a health route', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try { expect(await portListening(url)).toBe(true); }
    finally { await new Promise((resolve) => server.close(resolve)); }
    expect(await portListening(url)).toBe(false);
  });
  it.each(['win32', 'darwin'])('reads older installation status using the bundled %s fallback', async (platform) => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('unknown JSON option'))
      .mockResolvedValueOnce('{"running":false,"conflict":true}');
    expect(await serviceStatus({ root: 'selected installation' }, execute, platform)).toEqual({ running: false, conflict: true });
    expect(execute.mock.calls[1][1]).toContain('selected installation');
    expect(execute.mock.calls[1][1].some((arg) => arg.includes('status-' + (platform === 'win32' ? 'windows.ps1' : 'macos.sh')))).toBe(true);
  });
  it('does not follow redirects or expose health errors as healthy', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    expect((await probe('http://127.0.0.1/health', true, fetcher)).reachable).toBe(false);
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('reports external public access separately without treating it as a managed tunnel', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-external-health-'));
    try {
      await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(root, 'dist-server/server'), { recursive: true });
      for (const name of ['remote-control-windows.ps1', 'remote-control-macos.sh']) {
        await fs.writeFile(path.join(root, 'scripts', name), '', 'utf8');
      }
      await fs.writeFile(path.join(root, 'dist-server/server/index.js'), '', 'utf8');
      await fs.writeFile(path.join(root, 'package.json'), '{"name":"codex-remote","version":"0.1.10"}', 'utf8');
      await fs.writeFile(path.join(root, '.env'), 'PUBLIC_ORIGIN=https://remote.example.com\n', 'utf8');
      const execute = vi.fn().mockResolvedValue('{"running":true,"tunnelManaged":false}');
      const body = { ok: true, codex: 'ready', transport: 'desktop', passwordConfigured: true };
      const fetcher = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => body }));
      const result = await health(root, execute, 'darwin', fetcher);
      expect(result.publicEntry).toMatchObject({ configured: true, reachable: true, state: 'reachable' });
      expect(result.tunnel).toEqual({ managed: false, ready: false });
      expect(result.state).toBe('healthy');
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        'http://127.0.0.1:4545/health', 'https://remote.example.com/health'
      ]);
      expect(execute.mock.calls.every(([, args]) => args.includes('Status'))).toBe(true);
      fetcher.mockImplementation(async (url) => {
        if (url.startsWith('https:')) throw new Error('offline');
        return { ok: true, json: async () => body };
      });
      expect((await health(root, execute, 'darwin', fetcher)).publicEntry.reachable).toBe(false);
      await fs.writeFile(path.join(root, '.env'), '', 'utf8');
      fetcher.mockClear();
      expect((await health(root, execute, 'darwin', fetcher)).publicEntry.configured).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('does not mistake a generic proxy response for the Remote health endpoint', () => {
    expect(externalEntry({ reachable: true, body: { ok: true } })).toBe(false);
    expect(externalEntry({ reachable: false, body: { ok: true, codex: 'ready', transport: 'desktop' } })).toBe(false);
    expect(externalEntry({ reachable: true, body: { ok: true, codex: 'offline', transport: 'desktop' } })).toBe(true);
  });
  it('distinguishes uncertain network probes from HTTP and wrong-origin failures', async () => {
    const timeout = await probe('https://remote.example.com/health', true,
      async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
    expect(publicDiagnosis(timeout)).toMatchObject({ state: 'unknown' });
    expect(publicDiagnosis(timeout).detail).toContain('不能确认');
    const http = await probe('https://remote.example.com/health', true, async () => ({ ok: false, status: 530 }));
    expect(publicDiagnosis(http)).toMatchObject({ state: 'http-error' });
    expect(publicDiagnosis(http).detail).toContain('530');
    expect(publicDiagnosis({ reachable: true, body: { ok: true } }).state).toBe('unexpected');
    expect(publicDiagnosis(null).state).toBe('unconfigured');
  });
  it('sends sensitive subprocess input through stdin without including it in argv', async () => {
    const password = 'synthetic-secret-with-spaces';
    const value = await run(process.execPath, ['-e', 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({same:b==="synthetic-secret-with-spaces",args:process.argv.slice(1)})))'],
      { input: password });
    expect(JSON.parse(value)).toEqual({ same: true, args: [] });
  });
  it('allows a started service to await Desktop while preserving strict update verification', () => {
    const status = { state: 'degraded', service: { running: true }, backend: { ready: true },
      desktop: false, passwordConfigured: true, tunnel: { managed: false, ready: false },
      desktopDebug: { port: 9444, reachable: false, targetReady: false } };
    expect(startupReady(status, false)).toBe(true);
    expect(startupReady(status)).toBe(false);
    expect(diagnostics(status)[0]).toContain('127.0.0.1:9444');
    expect(diagnostics({ ...status, desktopDebug: { ...status.desktopDebug, reachable: true } })[0])
      .not.toBe(diagnostics(status)[0]);
    expect(diagnostics({ ...status, desktopDebug: { ...status.desktopDebug, reachable: true, targetReady: true } })[0])
      .not.toBe(diagnostics(status)[0]);
    expect(startupReady({ ...status, desktop: true })).toBe(true);
    expect(diagnostics({ ...status, desktop: true })).toEqual([]);
    for (const change of [{ backend: { ready: false } }, { service: { running: false } },
      { state: 'unowned' }, { state: 'conflict' }, { passwordConfigured: false },
      { tunnel: { managed: true, ready: false } }]) {
      expect(startupReady({ ...status, ...change }, false)).toBe(false);
    }
  });
  it('probes the configured Desktop endpoint only while the bridge is unavailable and projects no targets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-debug-health-'));
    try {
      await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(root, 'dist-server/server'), { recursive: true });
      for (const name of ['remote-control-windows.ps1', 'remote-control-macos.sh']) {
        await fs.writeFile(path.join(root, 'scripts', name), '', 'utf8');
      }
      await fs.writeFile(path.join(root, 'dist-server/server/index.js'), '', 'utf8');
      await fs.writeFile(path.join(root, 'package.json'), '{"name":"codex-remote","version":"0.1.11"}', 'utf8');
      await fs.writeFile(path.join(root, '.env'), 'CODEX_DESKTOP_DEBUG_PORT=9444\n', 'utf8');
      const execute = vi.fn().mockResolvedValue('{"running":true,"tunnelManaged":false}');
      let connected = false;
      const fetcher = vi.fn(async (url) => ({ ok: true, json: async () =>
        url.endsWith('/json/list') ? [{ type: 'page', url: 'app://-/index.html', secret: 'not-forwarded' }] :
          { ok: true, codex: 'ready', transport: connected ? 'desktop' : 'standalone', passwordConfigured: true } }));
      const pending = await health(root, execute, 'win32', fetcher);
      expect(pending.desktopDebug).toEqual({ port: 9444, reachable: true, targetReady: true });
      expect(pending.diagnostics).toHaveLength(1);
      expect(pending.state).toBe('degraded');
      expect(JSON.stringify(pending)).not.toContain('not-forwarded');
      expect(fetcher.mock.calls[1][0]).toBe('http://127.0.0.1:9444/json/list');
      connected = true; fetcher.mockClear();
      const recovered = await health(root, execute, 'win32', fetcher);
      expect(recovered.state).toBe('healthy');
      expect(recovered.diagnostics).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await fs.writeFile(path.join(root, '.env'), 'CODEX_DESKTOP_DEBUG_PORT=bad\n', 'utf8');
      await expect(health(root, execute, 'win32', fetcher)).rejects.toThrow('CODEX_DESKTOP_DEBUG_PORT');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('preserves binary output exactly for release comparisons', async () => {
    const bytes = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,10,10]))'], { raw: true });
    expect(bytes).toEqual(Buffer.from([0, 255, 10, 10]));
  });
});
