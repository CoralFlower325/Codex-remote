import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { commandEnvironment, control, serviceStatus, portListening } from './controller.mjs';
import { cleanOutput } from './update-progress.mjs';
import { run } from './process.mjs';

export async function repairControl(info, target, execute = run, platform = process.platform) {
  if (!['Server', 'Tunnel'].includes(target)) throw new Error('未知修复目标。');
  const status = await serviceStatus(info, execute, platform);
  if (status.conflict || !status.running || !status.enabled) throw new Error('请先确认服务归属并开启 Remote。');
  if (target === 'Tunnel' && (!status.tunnelManaged || platform !== 'win32')) {
    throw new Error('此隧道由外部工具管理，请在原管理工具中处理。');
  }
  if (platform === 'win32') {
    const script = fileURLToPath(new URL('./repair-windows.ps1', import.meta.url))
      .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Root', info.root, '-Target', target], { cwd: info.root, env: commandEnvironment(), timeout: 60_000 });
  } else if (platform === 'darwin' && target === 'Server') {
    await control(info.root, 'Stop', execute, platform);
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await serviceStatus(info, execute, platform);
      if (!current.running && !await portListening(info.localUrl)) {
        await control(info.root, 'Start', execute, platform);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('旧 Remote 尚未退出，已保留停止状态，请检查日志。');
  } else throw new Error('不支持此系统。');
}

export async function readDiagnosticLogs(info, kind) {
  if (!['Server', 'Tunnel'].includes(kind)) throw new Error('未知日志类型。');
  let env = {};
  try { env = parseEnv(await fs.readFile(path.join(info.root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const data = path.resolve(info.root, env.DATA_DIR?.trim() || 'data');
  const names = kind === 'Tunnel' ? ['cloudflared.log']
    : ['server.err.log', 'server.out.log', 'codex-remote.err.log', 'codex-remote.out.log'];
  const parts = [];
  for (const name of names) {
    let file;
    try {
      file = await fs.open(path.join(data, name), 'r');
      const stat = await file.stat();
      if (!stat.isFile()) continue;
      const buffer = Buffer.alloc(Math.min(stat.size, 8192));
      await file.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
      parts.push(`${name}\n${buffer.toString('utf8')}`);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本机日志。'); }
    finally { await file?.close(); }
  }
  return cleanOutput(parts.join('\n\n')).replace(/(cookie|session[-_]secret)\s*[=:]\s*\S+/gi, '$1=[已隐藏]')
    || '暂无此类日志。';
}
