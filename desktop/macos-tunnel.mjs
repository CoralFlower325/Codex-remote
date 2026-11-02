import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './process.mjs';

const launchctl = '/bin/launchctl';
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const appleString = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function tunnelArguments(job) {
  const args = job.ProgramArguments?.slice(1) || [];
  if (args.includes('tunnel') && args.includes('run')) return true;
  if (!['com.cloudflare.cloudflared', 'homebrew.mxcl.cloudflared'].includes(job.Label)) return false;
  // Standard cloudflared/Homebrew services may run without a subcommand.
  const values = new Set(['--config', '--logfile', '--loglevel', '--metrics', '--protocol']);
  for (let i = 0; i < args.length; i++) {
    if (['--no-autoupdate', '--origincert'].includes(args[i])) {
      if (args[i] === '--origincert' && typeof args[++i] !== 'string') return false;
    } else if (values.has(args[i])) {
      if (typeof args[++i] !== 'string') return false;
    } else if (!/^--(config|logfile|loglevel|metrics|protocol|origincert)=.+$/.test(args[i])) return false;
  }
  return true;
}

function directories() {
  return [
    { directory: path.join(os.homedir(), 'Library/LaunchAgents'), domain: `gui/${process.getuid()}` },
    { directory: '/Library/LaunchAgents', domain: `gui/${process.getuid()}` },
    { directory: '/Library/LaunchDaemons', domain: 'system' }
  ];
}

// Read only existing launchd definitions. Arguments/configuration never leave this module.
export async function discoverMacTunnels(execute = run, locations = directories()) {
  const services = [];
  for (const { directory, domain } of locations) {
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) continue; throw error; }
    for (const name of names.filter(name => name.endsWith('.plist')).sort().slice(0, 512)) {
      try {
        const plist = path.join(directory, name);
        const real = await fs.realpath(plist);
        const stat = await fs.stat(real);
        if (!stat.isFile() || stat.size > 256 * 1024) continue;
        // Never elevate a writable/user-owned definition into the system domain.
        if (domain === 'system' && (stat.uid !== 0 || (stat.mode & 0o022))) continue;
        const bytes = await fs.readFile(real);
        const job = JSON.parse(await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
          { input: bytes, timeout: 5000 }));
        const args = job.ProgramArguments;
        const executable = job.Program || args?.[0];
        if (typeof executable !== 'string' || !path.isAbsolute(executable) ||
          path.basename(executable) !== 'cloudflared' || !Array.isArray(args) ||
          !tunnelArguments(job) ||
          typeof job.Label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(job.Label)) continue;
        const fingerprint = createHash('sha256').update(bytes).update(real).digest('hex');
        const id = `${domain}/${job.Label}`;
        // Duplicate labels in one domain are ambiguous and must not be repaired.
        services.push({ id, label: job.Label, domain, plist, fingerprint });
      } catch { /* Ignore unrelated or unreadable definitions, without exposing their contents. */ }
    }
  }
  return services.filter(service => services.filter(other => other.id === service.id).length === 1);
}

export async function repairMacTunnel(selected, execute = run, locations) {
  const fresh = (await discoverMacTunnels(execute, locations)).find(service => service.id === selected?.id);
  if (!fresh || fresh.plist !== selected.plist || fresh.fingerprint !== selected.fingerprint) {
    throw new Error('Cloudflare 服务配置已改变，请重新点击修复并确认。');
  }
  let loaded = false;
  let current;
  try { current = await execute(launchctl, ['print', fresh.id], { timeout: 5000 }); loaded = true; }
  catch (error) {
    // Permission failures must not be mistaken for an unloaded job.
    if (!/could not find service|service not found|could not find specified service/i.test(error.message)) {
      throw new Error('无法读取 Cloudflare 服务状态，请检查系统服务权限后重试。');
    }
  }
  if (loaded) {
    const loadedPath = current.match(/^\s*path = (.+)$/m)?.[1]?.trim();
    const program = current.match(/^\s*program = (.+)$/m)?.[1]?.trim();
    if (!loadedPath || !program || path.basename(program) !== 'cloudflared' ||
      await fs.realpath(loadedPath).catch(() => null) !== await fs.realpath(fresh.plist)) {
      throw new Error('同名 Cloudflare 服务来自其他配置，请先在原管理工具中解决冲突。');
    }
  }
  // Explicit repair also restores a disabled existing job. It never creates a plist.
  const commands = [
    ['enable', fresh.id],
    ...(!loaded ? [['bootstrap', fresh.domain, fresh.plist]] : []),
    ['kickstart', '-k', fresh.id]
  ];
  try {
    if (fresh.domain === 'system') {
      const command = commands.map(args => [launchctl, ...args].map(quote).join(' ')).join(' && ');
      await execute('/usr/bin/osascript', ['-e',
        `do shell script ${appleString(command)} with administrator privileges`], { timeout: 120_000 });
    } else {
      for (const args of commands) await execute(launchctl, args, { timeout: 15_000 });
    }
  } catch (error) {
    if (/\(-128\)|user cancel/i.test(error.message)) throw new Error('已取消系统授权，未完成 Cloudflare 修复。');
    throw new Error('Cloudflare 服务未能重新启动，请检查系统授权、cloudflared 安装和现有隧道配置后重试。');
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await execute(launchctl, ['print', fresh.id], { timeout: 5000 }).catch(() => '');
    if (/^\s*state = running\s*$/m.test(state) && /^\s*pid = [1-9]\d*\s*$/m.test(state)) return;
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Cloudflare 启动后未保持运行，请检查 cloudflared 安装和现有服务配置。');
}
