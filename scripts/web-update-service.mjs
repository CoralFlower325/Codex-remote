import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../desktop/process.mjs';
import { probe, portListening } from '../desktop/controller.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function serviceCommand(root, action, platform = process.platform) {
  if (!['Status', 'Start', 'Stop'].includes(action)) throw new Error('未知服务操作。');
  if (platform === 'win32') return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(here, 'web-update-service-windows.ps1'), '-Root', root, '-Action', action]];
  if (platform === 'darwin') return ['/bin/bash', [path.join(here, 'web-update-service-macos.sh'), root, action]];
  throw new Error('网页更新支持 Windows x64 和 Apple Silicon。');
}

export async function service(root, action, execute = run, platform = process.platform) {
  const [file, args] = serviceCommand(root, action, platform);
  const result = await execute(file, args, { cwd: root, timeout: 60_000 });
  return action === 'Status' ? JSON.parse(result) : null;
}

export async function requireService(root, expectedPid, execute = run, platform = process.platform) {
  const status = await service(root, 'Status', execute, platform);
  if (!status.installed || status.conflict || !status.enabled || !status.running ||
    !status.pids.includes(expectedPid)) throw new Error('当前后端未由此安装的系统服务管理，请先在本机管理器开启 Remote。');
  return status;
}

export function serviceControls(info, requireDesktop, execute = run) {
  return {
    async stop() {
      await service(info.root, 'Stop', execute);
      for (let i = 0; i < 30; i++) {
        const status = await service(info.root, 'Status', execute);
        if (!status.running && !await portListening(info.localUrl)) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('旧 Remote 后端仍在退出，已停止替换文件。');
    },
    async start() {
      if (await portListening(info.localUrl)) throw new Error('后端端口仍被占用，已停止启动。');
      await service(info.root, 'Start', execute);
    },
    async verify() {
      for (let i = 0; i < 30; i++) {
        const state = await service(info.root, 'Status', execute);
        const result = await probe(`${info.localUrl}/health`);
        if (state.running && result.body?.ok === true && result.body.passwordConfigured === true &&
          (!requireDesktop || result.body.codex === 'ready' && result.body.transport === 'desktop')) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('更新后的 Remote 健康检查未通过。');
    },
    async isRunning() { return (await service(info.root, 'Status', execute)).running; }
  };
}

export async function launchWorker(job, execute = run, platform = process.platform) {
  const request = path.join(job, 'request.json');
  if (platform === 'win32') {
    const result = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(job, 'scripts', 'web-update-launch-windows.ps1'), '-Request', request],
    { cwd: job, timeout: 20_000 });
    const pid = Number(result);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('无法启动独立更新任务。');
    return pid;
  }
  if (platform === 'darwin') {
    const config = JSON.parse(await fs.readFile(request, 'utf8'));
    await execute('/bin/launchctl', ['submit', '-l', `com.codex.remote.update.${config.id}`,
      '-o', path.join(job, 'worker.log'), '-e', path.join(job, 'worker.err.log'), '--',
      process.execPath, path.join(job, 'scripts', 'web-update-worker.mjs'), request],
    { cwd: job, timeout: 20_000 });
    return null;
  }
  throw new Error('此系统不支持网页更新。');
}
