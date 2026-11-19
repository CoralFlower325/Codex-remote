import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';

const DEFAULT_TASK = 'CodexRemoteDomesticTunnel';

function commandEnvironment() {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DOTENV_CONFIG_PATH',
    'PORT', 'HOST', 'PUBLIC_ORIGIN', 'PUBLIC_ORIGINS', 'DATA_DIR']) delete env[key];
  return env;
}

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function port(value, fallback, name) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return parsed;
}

export function parseSshTunnel(env = {}, localPortFallback = 4545) {
  const keys = [
    'SSH_TUNNEL_MANAGED', 'SSH_TUNNEL_HOST', 'SSH_TUNNEL_USER', 'SSH_TUNNEL_KEY',
    'SSH_TUNNEL_REMOTE_PORT', 'SSH_TUNNEL_LOCAL_PORT', 'SSH_TUNNEL_TASK'
  ];
  const configured = keys.some((key) => String(env[key] ?? '').trim());
  if (!configured) return { configured: false, managed: false };
  const managed = enabled(env.SSH_TUNNEL_MANAGED);
  const host = String(env.SSH_TUNNEL_HOST ?? '').trim();
  const user = String(env.SSH_TUNNEL_USER ?? '').trim();
  const keyPath = String(env.SSH_TUNNEL_KEY ?? '').trim();
  const taskName = String(env.SSH_TUNNEL_TASK ?? DEFAULT_TASK).trim() || DEFAULT_TASK;
  if (managed && (!host || !user || !keyPath)) {
    throw new Error('Managed SSH tunnel requires SSH_TUNNEL_HOST, SSH_TUNNEL_USER and SSH_TUNNEL_KEY.');
  }
  if (host && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new Error('SSH_TUNNEL_HOST is invalid.');
  }
  if (user && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) {
    throw new Error('SSH_TUNNEL_USER is invalid.');
  }
  if (!/^CodexRemote[A-Za-z0-9_-]{1,80}$/.test(taskName)) {
    throw new Error('SSH_TUNNEL_TASK must start with CodexRemote and contain only letters, digits, _ or -.');
  }
  return {
    configured: true,
    managed,
    host,
    user,
    taskName,
    remotePort: port(env.SSH_TUNNEL_REMOTE_PORT, 14545, 'SSH_TUNNEL_REMOTE_PORT'),
    localPort: port(env.SSH_TUNNEL_LOCAL_PORT, localPortFallback, 'SSH_TUNNEL_LOCAL_PORT')
  };
}

export function sshTunnelScript() {
  return fileURLToPath(new URL('./ssh-tunnel-windows.ps1', import.meta.url))
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function unavailable(sshTunnel) {
  return {
    ...sshTunnel,
    supported: false,
    installed: false,
    enabled: false,
    taskState: '',
    running: false,
    ready: false,
    supervised: false,
    legacy: false,
    conflict: false
  };
}

export async function sshTunnelStatus(info, execute = run, platform = process.platform) {
  if (!info.sshTunnel?.managed) return unavailable(info.sshTunnel ?? { configured: false, managed: false });
  if (platform !== 'win32') return unavailable(info.sshTunnel);
  try {
    const output = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', sshTunnelScript(), '-Root', info.root, '-Action', 'Status'], {
      cwd: info.root, env: commandEnvironment(), timeout: 15_000
    });
    return { ...info.sshTunnel, supported: true, error: '', ...JSON.parse(output) };
  } catch {
    return { ...info.sshTunnel, supported: true, installed: false, enabled: false,
      taskState: '', running: false, ready: false, supervised: false, legacy: false,
      conflict: false, error: 'SSH 反向隧道状态读取失败；请检查配置、私钥文件与计划任务。' };
  }
}

export async function controlSshTunnel(info, action, execute = run, platform = process.platform) {
  if (!info.sshTunnel?.managed) return null;
  if (platform !== 'win32') throw new Error('SSH reverse-tunnel management is currently supported on Windows only.');
  if (!['Start', 'Stop', 'Repair'].includes(action)) throw new Error('Unknown SSH tunnel action.');
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', sshTunnelScript(), '-Root', info.root, '-Action', action], {
    cwd: info.root, env: commandEnvironment(), timeout: action === 'Stop' ? 30_000 : 60_000
  });
  return sshTunnelStatus(info, execute, platform);
}
