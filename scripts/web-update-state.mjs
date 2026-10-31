import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const updateDirectory = root => path.join(root, 'output', 'web-update');
export const activeUpdate = root => path.join(updateDirectory(root), 'active.json');
const publicDetails = {
  fetch: '正在获取正式版本，原服务继续运行。',
  compare: '正在检查本地文件和版本冲突。',
  dependencies: '正在临时目录安装依赖，原服务继续运行。',
  typecheck: '正在检查新版本代码。',
  test: '正在验证新版本。',
  build: '正在构建新版本，原服务继续运行。',
  offline: '正在验证离线安装。',
  runtime: '正在下载当前系统的预构建运行包。',
  unpack: '正在解压、校验文件和运行环境。',
  backup: '正在备份当前版本。',
  stop: '正在等待旧后端退出。',
  install: '正在安装新版本，后端会短暂离线。',
  verify: '正在启动后端并检查健康状态。',
  cleanup: '正在完成更新，保留旧版备份。',
  'restore-files': '正在恢复原有文件。',
  'restore-dependencies': '正在从本地备份恢复依赖。',
  'restore-service': '正在恢复原有服务状态。'
};
export const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const alive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export async function safeDirectory(directory) {
  const stat = await fs.lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('更新目录不安全。');
}

export async function ensureDirectory(root) {
  for (const directory of [path.join(root, 'output'), updateDirectory(root)]) {
    await safeDirectory(directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

export async function writeState(root, value) {
  await ensureDirectory(root);
  const target = activeUpdate(root);
  const temporary = path.join(updateDirectory(root), `${crypto.randomUUID()}.tmp`);
  const file = await fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
}

export async function readState(root) {
  await safeDirectory(path.join(root, 'output'));
  await safeDirectory(updateDirectory(root));
  const stat = await fs.lstat(activeUpdate(root)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024) throw new Error('更新记录无效。');
  const value = JSON.parse(await fs.readFile(activeUpdate(root), 'utf8'));
  if (value.root !== root || !validId(value.id) || !['running', 'completed', 'failed', 'recovered',
    'recovery-failed', 'interrupted'].includes(value.status)) throw new Error('更新记录不匹配。');
  return value;
}

// Only this public projection crosses HTTP. Logs, tool output and host paths stay local.
export function publicState(state) {
  if (!state) return null;
  const interrupted = state.status === 'running' && !alive(state.pid) && Date.now() - state.updatedAt > 30_000;
  const progress = state.progress;
  return {
    id: state.id, version: state.version, fromVersion: state.fromVersion,
    status: interrupted ? 'interrupted' : state.status,
    updatedAt: state.updatedAt,
    progress: progress ? {
      percent: progress.percent, step: progress.step, title: progress.title,
      detail: /^已下载 \d+\.\d \/ \d+\.\d MB。$/.test(progress.detail) ? progress.detail
        : state.status === 'running' ? publicDetails[progress.step] ?? '正在处理更新。'
          : state.message ?? (state.status === 'completed' ? '更新完成。' : '请重新检查更新状态。'),
      startedAt: progress.startedAt, stepStartedAt: progress.stepStartedAt,
      endedAt: progress.endedAt, status: progress.status
    } : null,
    ...(interrupted ? { message: '更新任务已中断，请恢复旧版后重试。' } : state.message ? { message: state.message } : {})
  };
}
