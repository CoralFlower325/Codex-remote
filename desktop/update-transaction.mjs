import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimePath, sha256 } from './runtime-package.mjs';

const activeFile = (root) => path.join(root, 'output', 'manager-update', 'active.json');
const mirrorFile = (root) => path.join(root, 'output', 'manager-update', 'active.mirror.json');
const execute = promisify(execFile);
export async function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid updater process id.');
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      ]);
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (!/^\d+$/.test(start ?? '') || !/^[a-f0-9-]+$/.test(boot.trim())) throw new Error('Invalid process identity.');
      return `linux:${boot.trim()}:${start}`;
    }
    const binary = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '/bin/ps';
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`]
      : process.platform === 'darwin' ? ['-p', String(pid), '-o', 'lstart='] : null;
    if (!args) throw new Error('Unsupported updater process identity platform.');
    const { stdout } = await execute(binary, args, { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: 'C' } });
    const value = stdout.trim();
    if (process.platform === 'win32' ? !/^\d{16,20}$/.test(value) : !/^[A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value)) {
      throw new Error('Updater process start time is unavailable.');
    }
    return `${process.platform}:${value}`;
  } catch (error) {
    try { process.kill(pid, 0); }
    catch (probe) { if (probe.code === 'ESRCH') return null; }
    throw new Error('Cannot verify updater process identity; preserving the lock.', { cause: error });
  }
}
export async function safeDirectory(directory) {
  const stat = await fs.lstat(directory).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('更新目录不能是链接或普通文件。');
}
export async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const file = await fs.open(directory, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
export async function syncTree(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error; return null;
  });
  if (!entries) return;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(target);
    else if (entry.isFile()) {
      const file = await fs.open(target, 'r+');
      try { await file.sync(); } finally { await file.close(); }
    }
  }
  await syncDirectory(directory);
}
export async function atomicWrite(target, bytes, mode = 0o644) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.codex-remote-${crypto.randomUUID()}.tmp`);
  const file = await fs.open(temporary, 'wx', mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try { await fs.rename(temporary, target); await syncDirectory(path.dirname(target)); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function safeFile(root, relative) {
  runtimePath(relative);
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`更新路径包含链接或类型冲突：${relative}`);
    }
  }
  return fs.readFile(cursor);
}
export async function acquireUpdateLock(root, identify = processStartIdentity) {
  await safeDirectory(path.join(root, 'output'));
  await fs.mkdir(path.join(root, 'output'), { recursive: true });
  const directory = path.join(root, 'output', 'manager-update');
  await safeDirectory(directory);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'lock.json');
  const owner = { pid: process.pid, processStart: await identify(process.pid), token: crypto.randomUUID() };
  if (!owner.processStart) throw new Error('Cannot identify the current updater process.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = path.join(directory, `lock-${crypto.randomUUID()}.tmp`);
    try {
      const file = await fs.open(candidate, 'wx');
      try { await file.writeFile(JSON.stringify(owner)); await file.sync(); }
      finally { await file.close(); }
      // Publish an already flushed owner record atomically; a killed process
      // cannot leave an empty lock with no identifiable owner.
      await fs.link(candidate, target);
      return async () => {
        let current;
        try { current = JSON.parse(await fs.readFile(target, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (current.token === owner.token) await fs.rm(target, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('更新锁文件无效。');
      let lock;
      try { lock = JSON.parse(await fs.readFile(target, 'utf8')); } catch {}
      // A malformed lock may be a different process still writing it.
      if (!Number.isInteger(lock?.pid) || lock.pid < 1) throw new Error('更新锁文件未完成，请稍后重试。');
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive && typeof lock.processStart === 'string') {
        const identity = await identify(lock.pid);
        alive = identity !== null && identity === lock.processStart;
      }
      if (alive) throw new Error('另一个管理器正在更新或恢复此安装，请等待其完成。');
      await fs.rm(target);
    } finally { await fs.rm(candidate, { force: true }); }
  }
  throw new Error('无法取得更新锁，请稍后重试。');
}
export async function pendingUpdate(directory) {
  const root = await fs.realpath(directory);
  await safeDirectory(path.join(root, 'output'));
  await safeDirectory(path.join(root, 'output', 'manager-update'));
  const read = async (target) => {
    try { return { data: await readJournal(root, target), error: null }; }
    catch (error) { return { data: null, error }; }
  };
  const [primary, mirror] = await Promise.all([read(activeFile(root)), read(mirrorFile(root))]);
  const valid = [primary.data, mirror.data].filter(Boolean);
  if (!valid.length) {
    if (primary.error || mirror.error) throw new Error('Update journals cannot be recovered; preserved all evidence.',
      { cause: primary.error || mirror.error });
    return null;
  }
  if (valid.length === 2) {
    if (valid[0].id !== valid[1].id || (valid[0].journalSequence ?? 0) === (valid[1].journalSequence ?? 0) &&
      JSON.stringify(valid[0]) !== JSON.stringify(valid[1])) {
      throw new Error('Update journals disagree; preserved all evidence.');
    }
    valid.sort((a, b) => (b.journalSequence ?? 0) - (a.journalSequence ?? 0));
  }
  return valid[0];
}
async function readJournal(root, target) {
  let stat;
  try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('更新事务记录无效。');
  let data;
  try { data = JSON.parse(await fs.readFile(target, 'utf8')); }
  catch (error) { throw new Error('更新事务记录无法读取，已保留现场，请先检查或恢复备份。', { cause: error }); }
  if (data?.journalSequence !== undefined || data?.journalChecksum !== undefined) {
    const { journalChecksum, ...payload } = data;
    if (!Number.isSafeInteger(payload.journalSequence) || payload.journalSequence < 1 ||
      !/^[a-f0-9]{64}$/.test(journalChecksum) || sha256(Buffer.from(JSON.stringify(payload))) !== journalChecksum) {
      throw new Error('Update journal checksum mismatch; preserved all evidence.');
    }
  }
  const backupRoot = path.join(root, 'output', `manager-backup-${data.id}`);
  if (data.format !== 1 || data.root !== root || !/^[a-f0-9-]{36}$/.test(data.id) ||
    !['prepared', 'stopping', 'installing', 'verifying', 'recovering', 'committed', 'recovered'].includes(data.phase) ||
    !Array.isArray(data.plan) || !data.backupFiles || typeof data.wasRunning !== 'boolean') {
    throw new Error('更新事务记录与当前安装不匹配。');
  }
  await safeDirectory(backupRoot);
  for (const item of data.plan) {
    runtimePath(item.relative);
    if (/^(?:node_modules|dist|dist-server)(?:\/|$)/.test(item.relative)) throw new Error('源码恢复计划无效。');
  }
  for (const [name, value] of Object.entries(data.backupFiles)) {
    runtimePath(name);
    if (!/^(?:source|dist|dist-server)\//.test(name) || !/^[a-f0-9]{64}$/.test(value)) throw new Error('更新备份清单无效。');
  }
  return { ...data, backup: backupRoot };
}
export async function recordUpdate(root, data, phase) {
  const next = { ...data, phase, journalSequence: (data.journalSequence ?? 0) + 1 };
  delete next.backup;
  delete next.journalChecksum;
  const journalChecksum = sha256(Buffer.from(JSON.stringify(next)));
  const bytes = JSON.stringify({ ...next, journalChecksum });
  // Flush both copies before permitting the next installation side effect.
  // Recovery selects the newest valid sequence after an interrupted write.
  await atomicWrite(mirrorFile(root), bytes);
  await atomicWrite(activeFile(root), bytes);
  Object.assign(data, { phase, journalSequence: next.journalSequence, journalChecksum });
}
export async function finishUpdate(root, data, phase) {
  await recordUpdate(root, data, phase);
  // Terminal active records are harmless if cleanup is interrupted.
  try {
    await fs.rm(activeFile(root), { force: true });
    await fs.rm(mirrorFile(root), { force: true });
    await syncDirectory(path.dirname(activeFile(root)));
  } catch { /* The durable terminal phase prevents an unnecessary rollback. */ }
}
export async function snapshotBackup(backup) {
  const files = {};
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(backup, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else {
        const bytes = await safeFile(backup, name);
        files[name] = sha256(bytes);
        const file = await fs.open(path.join(backup, name), 'r+');
        try { await file.sync(); } finally { await file.close(); }
      }
    }
    await syncDirectory(path.join(backup, relative));
  }
  for (const name of ['source', 'dist', 'dist-server']) {
    await fs.mkdir(path.join(backup, name), { recursive: true });
    await visit(name);
  }
  return files;
}
export async function restoreTransaction(root, transaction, { stop, start, verify, report, repairDependencies }) {
  const backup = transaction.backup || path.join(root, 'output', `manager-backup-${transaction.id}`);
  if (['committed', 'recovered'].includes(transaction.phase)) {
    await fs.rm(activeFile(root), { force: true });
    await fs.rm(mirrorFile(root), { force: true });
    return { backup, terminal: transaction.phase };
  }
  // Verify all recovery evidence before stopping or overwriting anything.
  for (const [name, expected] of Object.entries(transaction.backupFiles)) {
    const bytes = await safeFile(backup, name);
    if (!bytes || sha256(bytes) !== expected) throw new Error(`旧版备份不完整，已保留现场：${name}`);
  }
  for (const item of transaction.plan) {
    if (!item.preserve && item.before && transaction.backupFiles[`source/${item.relative}`] !== item.before) {
      throw new Error(`旧版源码备份清单不完整，已保留现场：${item.relative}`);
    }
  }
  for (const item of transaction.installationStarted ? transaction.plan : []) {
    if (item.preserve) continue;
    const bytes = await safeFile(root, item.relative);
    const current = bytes ? sha256(bytes) : null;
    if (current !== item.before && current !== item.after) {
      throw new Error(`中断后安装文件又被修改，已保留现场：${item.relative}`);
    }
  }
  const dependencies = path.join(backup, 'node_modules');
  await safeDirectory(dependencies);
  const hasBackup = Boolean(await fs.stat(dependencies).catch((error) => {
    if (error.code !== 'ENOENT') throw error; return null;
  }));
  if (transaction.dependenciesCaptured && transaction.hadDependencies && !hasBackup) {
    throw new Error('旧版依赖备份缺失，已保留更新现场。');
  }
  await recordUpdate(root, transaction, 'recovering');
  if (transaction.installationStarted || hasBackup) {
    report?.recovery('restore-files', '正在恢复中断的更新', 0, '正在确认服务已停止，并恢复原有文件。');
    await stop();
  }
  if (transaction.installationStarted) {
    for (const item of transaction.plan) {
      if (item.preserve) continue;
      const target = path.join(root, item.relative);
      if (item.before) {
        const bytes = await safeFile(backup, `source/${item.relative}`);
        if (!bytes || sha256(bytes) !== item.before) throw new Error('旧版源码备份不完整。');
        await atomicWrite(target, bytes, (await fs.stat(path.join(backup, 'source', item.relative))).mode);
      } else await fs.rm(target, { force: true });
      const prefix = `.${path.basename(target)}.codex-remote-`;
      const entries = await fs.readdir(path.dirname(target)).catch((error) => {
        if (error.code !== 'ENOENT') throw error; return [];
      });
      for (const name of entries) {
        if (name.startsWith(prefix) && /^[a-f0-9-]{36}\.tmp$/.test(name.slice(prefix.length))) {
          await fs.rm(path.join(path.dirname(target), name), { force: true });
        }
      }
    }
    for (const [name] of Object.entries(transaction.backupFiles)) {
      if (name.startsWith('source/')) continue;
      await safeFile(root, name);
      const stat = await fs.stat(path.join(backup, name));
      await atomicWrite(path.join(root, name), await safeFile(backup, name), stat.mode);
    }
  }
  if (hasBackup) {
    report?.recovery('restore-dependencies', '正在恢复旧版依赖', 40, '正在从本机备份恢复，无需连接网络。');
    const target = path.join(root, 'node_modules');
    await safeDirectory(target);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    // Keep the backup intact so another crash during recovery is recoverable.
    await fs.cp(dependencies, target, { recursive: true, verbatimSymlinks: true });
    await syncTree(target);
  } else if (transaction.dependenciesCaptured && !transaction.hadDependencies) {
    await safeDirectory(path.join(root, 'node_modules'));
    await fs.rm(path.join(root, 'node_modules'), { recursive: true, force: true });
    if (transaction.wasRunning && repairDependencies) {
      report?.recovery('restore-dependencies', '正在修复旧版依赖', 40, '原安装缺少依赖备份，正在修复旧版锁定依赖。');
      await repairDependencies();
    }
  }
  report?.recovery('restore-service', '正在确认旧版状态', 85, '正在恢复更新前的运行状态。');
  if (transaction.stopRequested && transaction.wasRunning) { await start(); await verify(); }
  await finishUpdate(root, transaction, 'recovered');
  report?.terminal('recovered', '已恢复旧版', transaction.wasRunning
    ? '已恢复旧版和更新前的运行状态。' : '已恢复旧版，服务保持关闭。');
  return { backup, terminal: 'recovered' };
}
export async function recoverPendingUpdate(directory, controls) {
  const root = await fs.realpath(directory);
  const release = await acquireUpdateLock(root);
  try {
    const transaction = await pendingUpdate(root);
    if (!transaction) return null;
    return await restoreTransaction(root, transaction, controls);
  } finally { await release(); }
}
