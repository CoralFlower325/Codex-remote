import { describe, it, expect, vi } from 'vitest';
import { controlCommand, summarize, probe, serviceStatus } from './controller.mjs';
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
  it('preserves binary output exactly for release comparisons', async () => {
    const bytes = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,10,10]))'], { raw: true });
    expect(bytes).toEqual(Buffer.from([0, 255, 10, 10]));
  });
});
