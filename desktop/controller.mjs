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
  const desktopDebugPort = Number(env.CODEX_DESKTOP_DEBUG_PORT || 9229);
  if (!Number.isInteger(desktopDebugPort) || desktopDebugPort < 1 || desktopDebugPort > 65535) {
    throw new Error('Invalid CODEX_DESKTOP_DEBUG_PORT in .env.');
  }
  let publicUrl = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('PUBLIC_ORIGIN must be an HTTP(S) URL without credentials.');
    }
    publicUrl = url.origin;
  }
  return { root, version: pkg.version, localUrl: `http://127.0.0.1:${port}`, publicUrl, desktopDebugPort };
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

export function externalEntry(result) {
  return Boolean(result?.reachable && result.body?.ok === true &&
    ['starting', 'ready', 'restarting', 'offline'].includes(result.body?.codex) &&
    typeof result.body?.transport === 'string');
}

export function diagnostics(status) {
  if (status.state === 'conflict') return ['系统服务属于另一个安装目录，请检查所选目录。'];
  if (status.state === 'unowned') return ['本机端口被其他服务占用，请先解决端口归属。'];
  if (status.state === 'stopped') return [];
  if (!status.backend.ready) return ['Remote 本地健康接口未就绪，请检查当前安装的服务错误日志。'];
  const messages = [];
  if (!status.desktop) {
    const address = `127.0.0.1:${status.desktopDebug.port}`;
    if (!status.desktopDebug.reachable) {
      messages.push(`Desktop 调试端点 ${address} 未就绪。普通启动 Codex 不一定开启此端口；请确认 Desktop 的调试启动参数，或 Codex++ 的调试连接状态。`);
    } else if (!status.desktopDebug.targetReady) {
      messages.push(`调试端点 ${address} 可达，但未找到 Codex Desktop 页面，请确认端口配置及 Desktop 是否已加载。`);
    } else messages.push('Desktop 调试页面可达，但原生会话桥尚未连接；Remote 会自动重试。');
  }
  if (!status.passwordConfigured) messages.push('尚未设置 Remote 访问密码，请在安装目录运行 npm run set-password。');
  if (status.tunnel.managed && !status.tunnel.ready) messages.push('受管隧道尚未就绪，请检查隧道状态。');
  return messages;
}

export function startupReady(status, requireDesktop = true) {
  return status.service.running && !['conflict', 'unowned', 'stopped'].includes(status.state) &&
    status.backend.ready && status.passwordConfigured &&
    (!status.tunnel.managed || status.tunnel.ready) && (!requireDesktop || status.desktop);
}

export async function health(directory, execute = run, platform = process.platform, fetcher = fetch) {
  const info = await installation(directory);
  const service = await serviceStatus(info, execute, platform);
  const [local, tunnel, listening, external] = await Promise.all([
    probe(`${info.localUrl}/health`, true, fetcher),
    service.tunnelManaged ? probe('http://127.0.0.1:20241/ready', false, fetcher)
      : Promise.resolve({ reachable: false, body: null }),
    portListening(info.localUrl),
    info.publicUrl ? probe(`${info.publicUrl}/health`, true, fetcher) : Promise.resolve(null)
  ]);
  const desktop = local.body?.codex === 'ready' && local.body?.transport === 'desktop';
  const debug = local.body?.ok === true && !desktop
    ? await probe(`http://127.0.0.1:${info.desktopDebugPort}/json/list`, true, fetcher) : null;
  // Do not forward the binary path or any other health response fields.
  const status = { ...info, checkedAt: Date.now(), service,
    backend: { reachable: local.reachable, ready: local.body?.ok === true, ms: local.ms },
    desktop,
    desktopDebug: { port: info.desktopDebugPort, reachable: desktop || Boolean(debug?.reachable),
      targetReady: desktop || Boolean(Array.isArray(debug?.body) &&
        debug.body.some((target) => target?.type === 'page' && typeof target?.url === 'string' &&
          target.url.includes('app://-/index.html'))) },
    passwordConfigured: local.body?.passwordConfigured === true,
    tunnel: { managed: Boolean(service.tunnelManaged), ready: tunnel.reachable },
    publicEntry: { configured: Boolean(info.publicUrl), reachable: externalEntry(external) },
    state: summarize(service, { ...local, listening }, tunnel) };
  return { ...status, diagnostics: diagnostics(status) };
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
