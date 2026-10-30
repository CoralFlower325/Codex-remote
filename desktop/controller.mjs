import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';

export async function installation(directory) {
  const root = await fs.realpath(directory);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'codex-remote') throw new Error('Please select a Codex Remote installation.');
  for (const file of [process.platform === 'darwin' ? 'scripts/remote-control-macos.sh' : 'scripts/remote-control-windows.ps1',
    'dist-server/server/index.js']) await fs.access(path.join(root, file));
  let env = {};
  try { env = parseEnv(await fs.readFile(path.join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(env.PORT || 4545);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT in .env.');
  let publicUrl = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('PUBLIC_ORIGIN must be an HTTP(S) URL without credentials.');
    }
    publicUrl = url.origin;
  }
  return { root, version: pkg.version, localUrl: `http://127.0.0.1:${port}`, publicUrl };
}

export function controlCommand(platform, root, action) {
  if (!['Start', 'Stop', 'Status'].includes(action)) throw new Error('Invalid action.');
  if (platform === 'win32') return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/remote-control-windows.ps1'), '-Action', action,
    ...(action === 'Status' ? ['-Json'] : ['-NoBrowser'])]];
  if (platform === 'darwin') return ['/bin/bash',
    [path.join(root, 'scripts/remote-control-macos.sh'), action,
      action === 'Status' ? '--json' : '--no-browser']];
  throw new Error('The manager supports Windows and macOS.');
}

// The selected installation's .env remains authoritative, independent of the shell
// that launched the manager.
export function commandEnvironment() {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DOTENV_CONFIG_PATH',
    'PORT', 'HOST', 'PUBLIC_ORIGIN', 'DATA_DIR']) delete env[key];
  if (process.platform === 'darwin') env.PATH = `${env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`;
  return env;
}

export async function serviceStatus(info, execute = run, platform = process.platform) {
  const [file, args] = controlCommand(platform, info.root, 'Status');
  const options = { cwd: info.root, env: commandEnvironment() };
  try { return JSON.parse(await execute(file, args, options)); }
  catch {
    // Earlier releases lack structured status. The bundled fallback only reads
    // ownership/process state; mutations still use the selected host's controls.
    const script = fileURLToPath(new URL(platform === 'win32' ? './status-windows.ps1' : './status-macos.sh', import.meta.url))
      .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const fallback = platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', info.root] : [script, info.root];
    return JSON.parse(await execute(file, fallback, options));
  }
}

export async function probe(url, json = true, fetcher = fetch) {
  const started = Date.now();
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(2500), redirect: 'error',
      cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = json ? await response.json() : null;
    return { reachable: true, ms: Date.now() - started, body };
  } catch { return { reachable: false, ms: Date.now() - started, body: null }; }
}

export function portListening(localUrl) {
  return new Promise((resolve) => {
    const url = new URL(localUrl);
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(url.port) });
    const finish = (listening) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function summarize(service, local, tunnel) {
  if (service.conflict) return 'conflict';
  if (!service.running && (local.reachable || local.listening)) return 'unowned';
  if (local.reachable && local.body?.ok === true) {
    if (local.body.codex !== 'ready' || local.body.transport !== 'desktop' ||
      local.body.passwordConfigured !== true || (service.tunnelManaged && !tunnel.reachable)) return 'degraded';
    return 'healthy';
  }
  return service.running ? 'degraded' : 'stopped';
}

export async function health(directory, execute = run, platform = process.platform, fetcher = fetch) {
  const info = await installation(directory);
  const service = await serviceStatus(info, execute, platform);
  const [local, tunnel, listening] = await Promise.all([
    probe(`${info.localUrl}/health`, true, fetcher),
    service.tunnelManaged ? probe('http://127.0.0.1:20241/ready', false, fetcher)
      : Promise.resolve({ reachable: false, body: null }),
    portListening(info.localUrl)
  ]);
  // Do not forward the binary path or any other health response fields.
  return { ...info, checkedAt: Date.now(), service,
    backend: { reachable: local.reachable, ms: local.ms },
    desktop: local.body?.codex === 'ready' && local.body?.transport === 'desktop',
    passwordConfigured: local.body?.passwordConfigured === true,
    tunnel: { managed: Boolean(service.tunnelManaged), ready: tunnel.reachable },
    state: summarize(service, { ...local, listening }, tunnel) };
}

export async function control(directory, action, execute = run, platform = process.platform) {
  const info = await installation(directory);
  const status = await serviceStatus(info, execute, platform);
  if (status.conflict) throw new Error('The system service belongs to another installation.');
  if (action === 'Start' && !status.running) {
    if (await portListening(info.localUrl)) throw new Error('This port already has an unmanaged backend. Stop it before starting.');
  }
  const [file, args] = controlCommand(platform, info.root, action);
  await execute(file, args, { cwd: info.root, env: commandEnvironment(), timeout: 120_000 });
}
