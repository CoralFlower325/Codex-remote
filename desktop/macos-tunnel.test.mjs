import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverMacTunnels, repairMacTunnel } from './macos-tunnel.mjs';

const roots = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-tunnel-'));
  roots.push(directory);
  const locations = [{ directory, domain: 'gui/501' }];
  const job = { Label: 'homebrew.mxcl.cloudflared',
    ProgramArguments: ['/opt/homebrew/bin/cloudflared', 'tunnel', 'run', '--token', 'PRIVATE_TEST_TOKEN'] };
  await fs.writeFile(path.join(directory, 'cloudflared.plist'), JSON.stringify(job));
  const execute = vi.fn(async (file, args, options) => {
    if (file === '/usr/bin/plutil') return options.input.toString('utf8');
    return `path = ${path.join(directory, 'cloudflared.plist')}\nprogram = /opt/homebrew/bin/cloudflared\nstate = running\npid = 123`;
  });
  return { directory, locations, job, execute };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('existing macOS Cloudflare services', () => {
  it('discovers official/Homebrew jobs without projecting secrets or changing their management', async () => {
    const { locations, execute } = await fixture();
    const services = await discoverMacTunnels(execute, locations);
    expect(services).toHaveLength(1);
    expect(JSON.stringify(services)).not.toContain('PRIVATE_TEST_TOKEN');
    expect(execute.mock.calls.every(([file]) => file === '/usr/bin/plutil')).toBe(true);
    execute.mockClear();
    await repairMacTunnel(services[0], execute, locations);
    expect(execute.mock.calls.filter(([file]) => file === '/bin/launchctl').map(([, args]) => args))
      .toEqual([['print', services[0].id], ['enable', services[0].id],
        ['kickstart', '-k', services[0].id], ['print', services[0].id]]);
  });
  it('bootstraps the selected existing job when unloaded', async () => {
    const { locations, execute } = await fixture();
    const [service] = await discoverMacTunnels(execute, locations);
    let reads = 0;
    execute.mockReset();
    execute.mockImplementation(async (file, args, options) => {
      if (file === '/usr/bin/plutil') return options.input.toString('utf8');
      if (args[0] === 'print' && reads++ === 0) throw new Error('Could not find service');
      return 'state = running\npid = 123';
    });
    await repairMacTunnel(service, execute, locations);
    expect(execute).toHaveBeenCalledWith('/bin/launchctl',
      ['bootstrap', service.domain, service.plist], expect.any(Object));
  });
  it('supports default official/Homebrew configurations but excludes other cloudflared modes', async () => {
    const { directory, locations, execute, job } = await fixture();
    await fs.writeFile(path.join(directory, 'cloudflared.plist'), JSON.stringify({
      ...job, ProgramArguments: ['/opt/homebrew/bin/cloudflared'] }));
    expect(await discoverMacTunnels(execute, locations)).toHaveLength(1);
    await fs.writeFile(path.join(directory, 'cloudflared.plist'), JSON.stringify({
      ...job, Label: 'com.cloudflare.cloudflared',
      ProgramArguments: ['/usr/local/bin/cloudflared', '--config', '/private/config.yml'] }));
    expect(await discoverMacTunnels(execute, locations)).toHaveLength(1);
    await fs.writeFile(path.join(directory, 'cloudflared.plist'), JSON.stringify({
      ...job, ProgramArguments: ['/opt/homebrew/bin/cloudflared', 'proxy-dns'] }));
    expect(await discoverMacTunnels(execute, locations)).toEqual([]);
  });
  it('refuses to restart a loaded label from a different plist', async () => {
    const { locations, execute } = await fixture();
    const [service] = await discoverMacTunnels(execute, locations);
    execute.mockImplementation(async (file, args, options) =>
      file === '/usr/bin/plutil' ? options.input.toString('utf8') : 'path = /other/service.plist');
    await expect(repairMacTunnel(service, execute, locations)).rejects.toThrow('其他配置');
    expect(execute.mock.calls.some(([, args]) => args[0] === 'kickstart')).toBe(false);
  });
  it('uses native administrator authorization only for the selected system job', async () => {
    const { directory, execute } = await fixture();
    const stat = fs.stat.bind(fs);
    const spy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) =>
      Object.assign(await stat(...args), { uid: 0, mode: 0o100644 }));
    try {
      const locations = [{ directory, domain: 'system' }];
      const [service] = await discoverMacTunnels(execute, locations);
      await repairMacTunnel(service, execute, locations);
      const calls = execute.mock.calls.filter(([file]) => file === '/usr/bin/osascript');
      expect(calls).toHaveLength(1);
      expect(calls[0][1][1]).toContain('with administrator privileges');
      expect(calls[0][1][1]).toContain('system/homebrew.mxcl.cloudflared');
      expect(calls[0][1][1]).not.toContain('PRIVATE_TEST_TOKEN');
      expect(calls[0][1][1]).not.toContain('com.codex.remote');
    } finally { spy.mockRestore(); }
  });
  it('reports cancelled administrator authorization and never reports success', async () => {
    const { directory, execute } = await fixture();
    const stat = fs.stat.bind(fs);
    const spy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) =>
      Object.assign(await stat(...args), { uid: 0, mode: 0o100644 }));
    try {
      const locations = [{ directory, domain: 'system' }];
      const [service] = await discoverMacTunnels(execute, locations);
      const original = execute.getMockImplementation();
      execute.mockImplementation(async (...args) => {
        if (args[0] === '/usr/bin/osascript') throw new Error('User canceled. (-128)');
        return original(...args);
      });
      await expect(repairMacTunnel(service, execute, locations)).rejects.toThrow('已取消系统授权');
      expect(execute.mock.calls.filter(([, args]) => args[0] === 'print')).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  it('does not treat a registered but exited job as a successful restart', async () => {
    const { locations, execute } = await fixture();
    const [service] = await discoverMacTunnels(execute, locations);
    const original = execute.getMockImplementation();
    let reads = 0;
    execute.mockImplementation(async (...args) => {
      if (args[1][0] === 'print' && reads++ > 0) return 'state = exited';
      return original(...args);
    });
    await expect(repairMacTunnel(service, execute, locations)).rejects.toThrow('未保持运行');
  }, 10_000);
  it('rejects changed definitions and duplicate labels before any launchctl mutation', async () => {
    const { directory, locations, execute, job } = await fixture();
    const [service] = await discoverMacTunnels(execute, locations);
    await fs.writeFile(service.plist, JSON.stringify({ ...job, KeepAlive: true }));
    await expect(repairMacTunnel(service, execute, locations)).rejects.toThrow('已改变');
    await fs.writeFile(path.join(directory, 'duplicate.plist'), JSON.stringify(job));
    expect(await discoverMacTunnels(execute, locations)).toEqual([]);
    expect(execute.mock.calls.some(([file]) => file === '/bin/launchctl')).toBe(false);
  });
  it('ignores unrelated jobs and does not bootstrap on a permission failure', async () => {
    const { directory, locations, execute, job } = await fixture();
    await fs.writeFile(path.join(directory, 'other.plist'), JSON.stringify({
      ...job, Label: 'other', ProgramArguments: ['/bin/sh', '-c', 'cloudflared tunnel run'] }));
    const services = await discoverMacTunnels(execute, locations);
    expect(services).toHaveLength(1);
    execute.mockImplementation(async (file, args, options) => {
      if (file === '/usr/bin/plutil') return options.input.toString('utf8');
      throw new Error('Operation not permitted');
    });
    await expect(repairMacTunnel(services[0], execute, locations)).rejects.toThrow('权限');
    expect(execute.mock.calls.some(([, args]) => ['enable', 'bootstrap', 'kickstart'].includes(args[0]))).toBe(false);
  });
});
