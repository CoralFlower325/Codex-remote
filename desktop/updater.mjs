import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUpdateProgress, updateError } from './update-progress.mjs';
import { regularFile, hash, buildFileNames, installDependencies, removePreparation } from './update-inputs.mjs';
import { acquireUpdateLock, pendingUpdate, recordUpdate, finishUpdate, snapshotBackup,
  restoreTransaction, atomicWrite, syncDirectory, syncTree } from './update-transaction.mjs';
export { compareVersions, latestRelease } from './release.mjs';
export { safeRelative, planFiles, nodeToolchain, mergeBuildInputs } from './update-inputs.mjs';
export { prepareUpdate } from './update-prepare.mjs';

async function copyTree(source, target) {
  await fs.mkdir(target, { recursive: true });
  await fs.cp(source, target, { recursive: true, dereference: false });
}

async function rejectLinkedDirectory(directory, recursive = false) {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe installation directory.');
    if (recursive) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Build directory contains a symbolic link.');
        if (entry.isDirectory()) await rejectLinkedDirectory(path.join(directory, entry.name), true);
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function installUpdate(prepared, { stop, start, verify, isRunning, progress, requireDesktop = false }) {
  const { stage, plan, tools, execute, release } = prepared;
  const info = { ...prepared.info, root: await fs.realpath(prepared.info.root) };
  const payload = prepared.payload || stage;
  const id = crypto.randomUUID();
  const backup = path.join(info.root, 'output', `manager-backup-${id}`);
  let wasRunning = false;
  let dependenciesSaved = false;
  let result;
  let transaction;
  let unlock;
  const report = prepared.report || createUpdateProgress(progress);
  const checkInputs = async () => {
    if (prepared.runtimeFiles && JSON.stringify(await buildFileNames(info.root)) !== JSON.stringify(prepared.runtimeFiles)) {
      throw new Error('Installation changed during preparation: build file list');
    }
    for (const item of [...plan, ...(prepared.inputs || [])]) {
      if (hash(await regularFile(info.root, item.relative)) !== item.before) {
        throw new Error(`Installation changed during preparation: ${item.relative}`);
      }
    }
  };
  try {
    unlock = await acquireUpdateLock(info.root);
    if (await pendingUpdate(info.root)) throw new Error('检测到未完成更新，请先恢复旧版。');
    report.start('backup');
    wasRunning = await isRunning();
    for (const dir of ['output', 'node_modules']) await rejectLinkedDirectory(path.join(info.root, dir));
    for (const dir of ['dist', 'dist-server']) await rejectLinkedDirectory(path.join(info.root, dir), true);
    await checkInputs();
    await fs.mkdir(backup, { recursive: true });
    for (const item of plan) {
      const bytes = await regularFile(info.root, item.relative);
      if (bytes) {
        await fs.mkdir(path.dirname(path.join(backup, 'source', item.relative)), { recursive: true });
        await fs.writeFile(path.join(backup, 'source', item.relative), bytes);
      }
      if (item.preserve && !item.remove) {
        await fs.mkdir(path.dirname(path.join(backup, 'incoming', item.relative)), { recursive: true });
        await fs.copyFile(path.join(payload, item.relative), path.join(backup, 'incoming', item.relative));
      }
      const incoming = item.remove ? null : await regularFile(payload, item.relative);
      item.after = hash(incoming);
    }
    for (const dir of ['dist', 'dist-server']) await copyTree(path.join(info.root, dir), path.join(backup, dir));
    await atomicWrite(path.join(backup, 'receipt.json'), JSON.stringify({
      from: info.version, to: release.version, commit: prepared.commit, plan, wasRunning
    }, null, 2));
    transaction = { format: 1, id, root: info.root, from: info.version, to: release.version,
      plan, wasRunning, requireDesktop, backupFiles: await snapshotBackup(backup),
      hadDependencies: Boolean(await fs.stat(path.join(info.root, 'node_modules')).catch((error) => {
        if (error.code !== 'ENOENT') throw error; return null;
      })),
      dependenciesCaptured: false, installationStarted: false, stopRequested: false };
    await recordUpdate(info.root, transaction, 'prepared');
    report.finish('backup');
    report.start('stop');
    transaction.stopRequested = true;
    await recordUpdate(info.root, transaction, 'stopping');
    await stop();
    await checkInputs();
    report.finish('stop');
    report.start('install');
    try {
      await fs.rename(path.join(info.root, 'node_modules'), path.join(backup, 'node_modules'));
      dependenciesSaved = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await syncDirectory(backup);
    await syncDirectory(info.root);
    transaction.dependenciesCaptured = true;
    transaction.installationStarted = true;
    await recordUpdate(info.root, transaction, 'installing');
    for (const item of plan) {
      if (item.preserve) continue;
      const target = path.join(info.root, item.relative);
      if (item.remove) await fs.rm(target, { force: true });
      else {
        const source = path.join(payload, item.relative);
        await atomicWrite(target, await fs.readFile(source), (await fs.stat(source)).mode);
      }
    }
    // Replace individual files atomically so a crash never truncates the
    // service entry or a platform control needed by startup recovery.
    const installTree = async (relative) => {
      for (const entry of await fs.readdir(path.join(payload, relative), { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await installTree(name);
        else {
          await regularFile(info.root, name);
          const source = path.join(payload, name);
          await atomicWrite(path.join(info.root, name), await fs.readFile(source), (await fs.stat(source)).mode);
        }
      }
    };
    for (const dir of ['dist', 'dist-server']) await installTree(dir);
    if (prepared.mode === 'runtime') {
      report.note('正在安装已校验的预构建运行依赖，无需运行 npm 或本机构建。');
      await copyTree(path.join(payload, 'node_modules'), path.join(info.root, 'node_modules'));
    } else {
      report.note('正在从已验证的本次缓存离线安装依赖；旧版依赖已保留供恢复。');
      await installDependencies(tools, info.root, execute, report, true);
    }
    await syncTree(path.join(info.root, 'node_modules'));
    report.finish('install');
    report.start('verify');
    await recordUpdate(info.root, transaction, 'verifying');
    if (wasRunning) {
      await start();
      await verify();
    } else report.note('更新前服务处于关闭状态，本次保持关闭。');
    report.finish('verify');
    await finishUpdate(info.root, transaction, 'committed');
    result = { version: release.version, backup, wasRunning, dependenciesSaved, edgeSyncRequired: Boolean(info.publicUrl),
      mode: prepared.mode || 'source', preservedFiles: plan.filter((item) => item.preserve).map((item) => item.relative) };
  } catch (error) {
    report.output(error.message);
    if (transaction && transaction.phase !== 'committed') {
      try {
        // An install originally missing dependencies has no offline recovery
        // source. Keep the compatibility repair for this in-process case.
        await restoreTransaction(info.root, { ...transaction, backup }, {
          stop, start, verify, report, ...(prepared.mode !== 'runtime'
            ? { repairDependencies: () => installDependencies(tools, info.root, execute, report) } : {})
        });
      } catch (rollback) {
        const message = `新版本安装失败，自动恢复也未能完成，需要人工处理。\n备份位置：${backup}\n${updateError(rollback)}`;
        report.terminal('recovery-failed', '旧版恢复未完成', message, rollback);
        throw new Error(message, { cause: rollback });
      }
      const message = `${transaction.installationStarted ? '新版本安装未完成，已恢复旧版和更新前的运行状态。' : '尚未替换安装文件，已恢复更新前的运行状态。'}\n${updateError(error)}`;
      report.terminal('recovered', '已恢复旧版', message);
      throw new Error(message, { cause: error });
    }
    const message = `尚未替换安装文件，更新已停止。\n${updateError(error)}`;
    report.terminal('failed', '更新未完成', message);
    throw new Error(message, { cause: error });
  } finally {
    if (result) report.start('cleanup');
    const cleaned = await removePreparation(stage, tools?.cache);
    if (unlock) await unlock();
    if (result) {
      result.cleanupWarning = cleaned ? '' : '更新已完成，但部分临时文件未能清理，可稍后清理。';
      report.terminal('completed', '更新完成',
        result.cleanupWarning || (wasRunning ? '新版已安装，本机服务检查通过。' : '新版已安装，服务保持关闭。'));
    }
  }
  return result;
}
