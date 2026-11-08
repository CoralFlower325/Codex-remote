import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { TunnelSupervisor, type TunnelChild } from '../tunnel-supervisor.js';
import { boundedLogWriter } from '../../../scripts/rotating-log.mjs';

const [binary, protocol = 'http2'] = process.argv.slice(2);
const root = process.cwd();
const token = path.join(root, 'data/cloudflared-token');
if (!binary || !existsSync(binary) || !existsSync(token) || !['auto', 'http2', 'quic'].includes(protocol)) {
  throw new Error('A cloudflared executable, token file and supported tunnel protocol are required.');
}
const supervisorLog = boundedLogWriter(path.join(root, 'data/tunnel-supervisor.log'));
const cloudflaredLog = boundedLogWriter(path.join(root, 'data/cloudflared.log'));
const log = (message: string) => { supervisorLog(`${new Date().toISOString()} ${message}\n`); };

const supervisor = new TunnelSupervisor({
  log,
  network: () => Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).filter(address => !address.internal)
      .map(address => `${name}:${address.family}:${address.address}`)).sort().join('|'),
  start: () => new Promise<TunnelChild>((resolve, reject) => {
    const child = spawn(binary, ['tunnel', '--protocol', protocol, '--no-autoupdate',
      '--metrics', '127.0.0.1:20241', '--loglevel', 'info',
      'run', '--token-file', token],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = (data: Buffer) => { cloudflaredLog(data); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    child.once('error', reject);
    child.once('spawn', () => resolve({
      exited,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await exited;
      }
    }));
  }),
  ready: async () => {
    try {
      const response = await fetch('http://127.0.0.1:20241/metrics', { signal: AbortSignal.timeout(1000) });
      return response.ok && Number((await response.text()).match(
        /^cloudflared_tunnel_ha_connections\s+(\d+)/m)?.[1] ?? 0) > 0;
    } catch { return false; }
  },
  egressReady: async () => {
    const probe = (host: string) => new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port: 7844, timeout: 1500 });
      const timer = setTimeout(() => socket.destroy(new Error('Tunnel edge probe timed out.')), 1800);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
      socket.once('timeout', () => socket.destroy(new Error('Tunnel edge probe timed out.')));
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    try {
      await Promise.any(['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'].map(probe));
      return true;
    } catch { return false; }
  }
});

// Windows reports route/address changes even when this Node process keeps its IP.
const watcher = process.platform === 'win32' ? spawn('powershell.exe', ['-NoProfile',
  '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/watch-network-windows.ps1')],
{ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) : null;
watcher?.stdout?.on('data', () => supervisor.networkChanged());
watcher?.on('error', () => log('Network event listener unavailable; readiness polling remains active.'));
const stop = () => { supervisor.stop(); watcher?.kill(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try { await supervisor.run(); }
finally { watcher?.kill(); }
