import { describe, expect, it, vi } from 'vitest';
import { controlSshTunnel, parseSshTunnel, sshTunnelStatus } from './ssh-tunnel.mjs';

const info = {
  root: 'C:\\Codex Remote',
  sshTunnel: {
    configured: true,
    managed: true,
    host: 'edge.example.com',
    user: 'codexremote',
    taskName: 'CodexRemoteDomesticTunnel',
    remotePort: 14545,
    localPort: 4545
  }
};

describe('managed SSH reverse tunnel', () => {
  it('parses an explicit configuration without exposing the private key', () => {
    expect(parseSshTunnel({})).toEqual({ configured: false, managed: false });
    expect(parseSshTunnel({
      SSH_TUNNEL_MANAGED: '1',
      SSH_TUNNEL_HOST: 'edge.example.com',
      SSH_TUNNEL_USER: 'codexremote',
      SSH_TUNNEL_KEY: 'C:/private/key',
      SSH_TUNNEL_REMOTE_PORT: '14545',
      SSH_TUNNEL_LOCAL_PORT: '4545'
    })).toEqual({
      configured: true,
      managed: true,
      host: 'edge.example.com',
      user: 'codexremote',
      taskName: 'CodexRemoteDomesticTunnel',
      remotePort: 14545,
      localPort: 4545
    });
    expect(parseSshTunnel({
      SSH_TUNNEL_MANAGED: '1', SSH_TUNNEL_HOST: 'edge.example.com',
      SSH_TUNNEL_USER: 'codexremote', SSH_TUNNEL_KEY: 'C:/private/key'
    }, 5000).localPort).toBe(5000);
  });

  it('rejects incomplete or unsafe managed settings', () => {
    expect(() => parseSshTunnel({ SSH_TUNNEL_MANAGED: '1' })).toThrow('requires');
    expect(() => parseSshTunnel({
      SSH_TUNNEL_MANAGED: '1', SSH_TUNNEL_HOST: '-bad', SSH_TUNNEL_USER: 'remote', SSH_TUNNEL_KEY: 'key'
    })).toThrow('HOST');
    expect(() => parseSshTunnel({
      SSH_TUNNEL_MANAGED: '1', SSH_TUNNEL_HOST: 'edge.example.com', SSH_TUNNEL_USER: 'bad user',
      SSH_TUNNEL_KEY: 'key'
    })).toThrow('USER');
    expect(() => parseSshTunnel({
      SSH_TUNNEL_MANAGED: '1', SSH_TUNNEL_HOST: 'edge.example.com', SSH_TUNNEL_USER: 'remote',
      SSH_TUNNEL_KEY: 'key', SSH_TUNNEL_TASK: 'ArbitraryTask'
    })).toThrow('TASK');
    expect(() => parseSshTunnel({
      SSH_TUNNEL_MANAGED: '1', SSH_TUNNEL_HOST: 'edge.example.com', SSH_TUNNEL_USER: 'remote',
      SSH_TUNNEL_KEY: 'key', SSH_TUNNEL_REMOTE_PORT: '70000'
    })).toThrow('REMOTE_PORT');
  });

  it('reports unsupported platforms and executes only owned Windows actions', async () => {
    const execute = vi.fn().mockResolvedValue('{"ready":true,"installed":true,"enabled":true}');
    expect(await sshTunnelStatus(info, execute, 'darwin')).toMatchObject({ managed: true, supported: false });
    expect(execute).not.toHaveBeenCalled();
    expect(await sshTunnelStatus(info, execute, 'win32')).toMatchObject({ ready: true, installed: true });
    expect(execute.mock.calls[0][1].some((arg) => String(arg).includes('ssh-tunnel-windows.ps1'))).toBe(true);
    await expect(controlSshTunnel(info, 'Start', execute, 'darwin')).rejects.toThrow('Windows');
    await controlSshTunnel(info, 'Start', execute, 'win32');
    await controlSshTunnel(info, 'Repair', execute, 'win32');
    await controlSshTunnel(info, 'Stop', execute, 'win32');
    expect(execute.mock.calls.slice(1).map(([, args]) => args.at(-1))).toEqual([
      'Start', 'Status', 'Repair', 'Status', 'Stop', 'Status'
    ]);
  });

  it('keeps health readable when native status cannot be parsed', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('private diagnostic'));
    expect(await sshTunnelStatus(info, execute, 'win32')).toMatchObject({
      managed: true,
      supported: true,
      ready: false,
      error: expect.stringContaining('状态读取失败')
    });
  });
});
