import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { run } from './process.mjs';
import { installation, commandEnvironment } from './controller.mjs';
import { createUpdateProgress, networkFailure, updateError } from './update-progress.mjs';
import { runtimeNames, validateManifest, downloadAsset, unpackRuntime, sourceHash } from './runtime-package.mjs';
import { acquireUpdateLock, pendingUpdate, recordUpdate, finishUpdate, snapshotBackup,
  restoreTransaction, atomicWrite, syncDirectory, syncTree } from './update-transaction.mjs';

const repository = 'https://github.com/CoralFlower325/Codex-remote.git';
const api = 'https://api.github.com/repos/CoralFlower325/Codex-remote/releases/latest';
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a, b) {
  const x = versionPattern.exec(a); const y = versionPattern.exec(b);
  if (!x || !y) throw new Error('Unsupported version format.');
  for (let i = 1; i < 4; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1;
  return 0;
}

export async function latestRelease(installedVersion, fetcher = fetch) {
  const response = await fetcher(api, { headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Release check failed (HTTP ${response.status}).`);
  const data = await response.json();
  if (!versionPattern.test(data.tag_name) || data.draft || data.prerelease) throw new Error('Invalid stable release.');
  return { version: data.tag_name.replace(/^v/, ''), tag: data.tag_name,
    notes: String(data.body || '').slice(0, 16_000),
    assets: Array.isArray(data.assets) ? data.assets.map(({ name, size, digest, browser_download_url }) =>
      ({ name, size, digest, browser_download_url })) : [],
    available: compareVersions(data.tag_name, installedVersion) > 0 };
}

export function safeRelative(file) {
  if (!file || file.includes('\\') || file.startsWith('/') ||
    file.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^(?:data|output|node_modules|\.git|\.env[^/]*)(?:\/|$)/i.test(file)) {
    throw new Error('The release contains a protected path.');
  }
  return file;
}

async function regularFile(root, relative) {
  safeRelative(relative);
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`Unsafe installation path: ${relative}`);
      }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return fs.readFile(cursor);
}

export async function planFiles(root, stage, files, readBase) {
  const plan = [];
  const conflicts = [];
  for (const relative of files) {
    safeRelative(relative);
    const [local, incoming, base] = await Promise.all([
      regularFile(root, relative), regularFile(stage, relative), readBase(relative)
    ]);
    if (sameContent(local, incoming)) continue;
    if ((local && !base) || (base && !sameContent(local, base))) {
      // Installation notes and local agent rules are not runtime build inputs.
      // Retain them, including deliberate deletions; save incoming copies later.
      if (/^(?:AGENTS\.md|CLAUDE\.md|README(?:\.[\w-]+)?\.md|docs\/.+\.md)$/.test(relative)) {
        plan.push({ relative, remove: !incoming, preserve: true });
      } else conflicts.push(relative);
    }
    else plan.push({ relative, remove: !incoming });
  }
  if (conflicts.length) throw new Error(`Local changes conflict with this update:\n${conflicts.slice(0, 12).join('\n')}`);
  return plan;
}

function sameContent(a, b) {
  if (!a || !b) return a === b;
  if (a.equals(b)) return true;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    if (a.includes(0) || b.includes(0)) return false;
    return decoder.decode(a).replace(/\r\n/g, '\n') === decoder.decode(b).replace(/\r\n/g, '\n');
  } catch { return false; }
}

export async function nodeToolchain(execute = run) {
  const env = commandEnvironment();
  const found = await execute(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['node'], { env });
  const node = found.split(/\r?\n/)[0];
  const version = await execute(node, ['--version'], { env });
  if (compareVersions(version, '22.19.0') < 0) throw new Error('Node.js 22.19+ is required.');
  const npmPath = await execute(node, ['--input-type=module', '-e',
    'import fs from "node:fs";import path from "node:path";const n=process.execPath;const p=process.platform==="win32"?path.join(path.dirname(n),"node_modules/npm/bin/npm-cli.js"):fs.realpathSync(process.argv[1]);process.stdout.write(p);',
    ...(process.platform === 'win32' ? [] : [(await execute('/usr/bin/which', ['npm'], { env })).split('\n')[0]])], { env });
  return { node, npmPath, env };
}

async function runtimeNode(execute) {
  const env = commandEnvironment();
  const found = await execute(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['node'], { env });
  const node = found.split(/\r?\n/)[0];
  const version = await execute(node, ['--version'], { env });
  if (compareVersions(version, '22.19.0') < 0) throw new Error('Node.js 22.19+ is required.');
  return { node, env };
}

const hash = (bytes) => bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null;

function npmCommand(tools, args, cwd, onLine) {
  return [tools.node, [tools.npmPath, '--cache', tools.cache, ...args],
    { cwd, env: tools.env, timeout: 600_000, onLine }];
}

async function removePreparation(stage, cache) {
  const results = await Promise.allSettled([stage, cache].filter(Boolean)
    .map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })));
  return results.every((result) => result.status === 'fulfilled');
}

async function withNetworkRetry(operation, report) {
  try { return await operation(); }
  catch (error) {
    if (!networkFailure(error)) throw error;
    report.output(error.message);
    report.note('网络连接中断，正在进行最后一次重试；已完成的更新进度保留。');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return operation();
  }
}

function installDependencies(tools, cwd, execute, report, offline = false) {
  const operation = () => execute(...npmCommand(offline
    ? { ...tools, env: { ...tools.env, npm_config_offline: 'true' } } : tools,
    ['ci', '--no-audit', '--no-fund', '--foreground-scripts', '--loglevel=http',
      ...(offline ? ['--offline'] : ['--prefer-offline']),
      '--fetch-retries=3', '--fetch-retry-mintimeout=1000',
      '--fetch-retry-maxtimeout=10000', '--fetch-timeout=60000'],
    cwd, report.output));
  return offline ? operation() : withNetworkRetry(operation, report);
}

export async function mergeBuildInputs(root, stage, plan) {
  const changed = new Set(plan.map((item) => item.relative));
  const inputs = [];
  const visit = async (relative) => {
    if (changed.has(relative)) return;
    const local = path.join(root, relative); const incoming = path.join(stage, relative);
    const stats = await Promise.all([local, incoming].map(async (file) => {
      try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    if (stats.some((stat) => stat?.isSymbolicLink())) throw new Error(`Unsafe build input: ${relative}`);
    if (stats.some((stat) => stat?.isDirectory())) {
      if (stats.some((stat) => stat && !stat.isDirectory())) throw new Error(`Conflicting build input: ${relative}`);
      const names = new Set();
      for (let i = 0; i < 2; i++) if (stats[i]) {
        for (const name of await fs.readdir(i === 0 ? local : incoming)) {
          if (['node_modules', '.git'].includes(name)) throw new Error(`Unsafe build input: ${relative}/${name}`);
          names.add(name);
        }
      }
      for (const name of names) await visit(`${relative}/${name}`);
      return;
    }
    const bytes = await regularFile(root, relative);
    inputs.push({ relative, before: hash(bytes) });
    if (bytes) {
      await fs.mkdir(path.dirname(incoming), { recursive: true });
      await fs.writeFile(incoming, bytes);
    } else await fs.rm(incoming, { force: true });
  };
  for (const dir of ['src', 'public', 'scripts']) await visit(dir);
  const names = new Set([...(await fs.readdir(root)), ...(await fs.readdir(stage))]);
  for (const name of names) {
    if (/^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite[^/]*\.config\.[cm]?[jt]s)$/.test(name)) await visit(name);
  }
  return inputs;
}

async function buildFileNames(root) {
  const result = [];
  const visit = async (relative) => {
    const stat = await fs.lstat(path.join(root, relative)).catch((error) => {
      if (error.code !== 'ENOENT') throw error; return null;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Unsafe build input: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(path.join(root, relative))) await visit(`${relative}/${name}`);
    } else result.push(relative);
  };
  for (const name of ['src', 'public', 'scripts']) await visit(name);
  for (const name of await fs.readdir(root)) {
    if (/^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite[^/]*\.config\.[cm]?[jt]s)$/.test(name)) await visit(name);
  }
  return result.sort();
}

// Preparation is side-effect free for the live installation: fetch, compare and
// build in an isolated directory before any service is stopped.
export async function prepareUpdate(directory, release, progress, execute = run, options = {}) {
  const info = await installation(directory);
  if (await pendingUpdate(info.root)) throw new Error('检测到未完成更新，请先恢复旧版。');
  if (!versionPattern.test(release.tag) || compareVersions(release.tag, info.version) <= 0) {
    throw new Error('没有可安装的新版本，请重新检查版本。');
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-update-'));
  const report = createUpdateProgress(progress);
  let cache;
  try {
    const names = runtimeNames(release.version);
    const manifestAsset = release.assets?.find((asset) => asset.name === names.manifest);
    const archiveAsset = release.assets?.find((asset) => asset.name === names.archive);
    if (manifestAsset || archiveAsset) {
      if (!manifestAsset || !archiveAsset) throw new Error('当前平台的运行包尚未发布完整，请稍后重新检查更新。');
      report.start('fetch');
      if (manifestAsset.size > 8 * 1024 * 1024) throw new Error('运行包清单过大。');
      const manifestFile = path.join(stage, 'manifest.json');
      await withNetworkRetry(async () => {
        await fs.rm(manifestFile, { force: true });
        await downloadAsset(manifestAsset, manifestFile, options);
      }, report);
      const manifest = validateManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')), release);
      report.finish('fetch');
      report.start('compare');
      const baseline = manifest.baselines[info.version];
      if (baseline) {
        const plan = [];
        const inputs = [];
        let custom = false;
        const names = new Set([...Object.keys(baseline), ...Object.keys(manifest.sources)]);
        for (const relative of names) {
          const local = await regularFile(info.root, relative);
          const localHash = local ? sourceHash(local) : null;
          const before = baseline[relative] || null;
          const after = manifest.sources[relative] || null;
          inputs.push({ relative, before: hash(local) });
          if (localHash !== before && /^(?:src\/|public\/|scripts\/|package(?:-lock)?\.json$|tsconfig|vite)/.test(relative)) {
            custom = true;
          }
          if (before === after || localHash === after) continue;
          const preserve = localHash !== before;
          if (preserve && !/^(?:AGENTS\.md|CLAUDE\.md|README(?:\.[\w-]+)?\.md|docs\/.+\.md)$/.test(relative)) {
            custom = true;
          }
          plan.push({ relative, remove: !after, before: hash(local), ...(preserve ? { preserve: true } : {}) });
        }
        // An untracked local build input must also retain its behavior.
        const runtimeFiles = await buildFileNames(info.root);
        if (runtimeFiles.some((name) => !names.has(name))) custom = true;
        if (!custom) {
          const tools = await runtimeNode(execute);
          report.finish('compare');
          report.start('runtime');
          const archive = path.join(stage, 'runtime.tar.gz');
          if (archiveAsset.size !== manifest.archive.size || archiveAsset.digest !== `sha256:${manifest.archive.sha256}`) {
            throw new Error('Release 与运行包清单的校验值不一致。');
          }
          await withNetworkRetry(async () => {
            await fs.rm(archive, { force: true });
            await downloadAsset(archiveAsset, archive, { ...options,
              progress: (loaded, total) => report.download(loaded, total) });
          }, report);
          report.finish('runtime');
          report.start('unpack');
          const payload = path.join(stage, 'payload');
          await unpackRuntime(archive, payload, manifest);
          const pkg = JSON.parse(await fs.readFile(path.join(payload, 'package.json'), 'utf8'));
          if (pkg.name !== 'codex-remote' || pkg.version !== release.version) throw new Error('Release version mismatch.');
          await execute(tools.node, ['scripts/check-runtime.mjs'], { cwd: payload, env: tools.env, timeout: 30_000, onLine: report.output });
          report.finish('unpack');
          return { info, stage, payload, plan, inputs, runtimeFiles, tools, commit: manifest.commit, release, execute, report, mode: 'runtime' };
        }
        report.note('检测到本机源码定制，将使用隔离源码构建以保留现有行为。');
      } else report.note('此安装版本不在运行包基线中，将使用兼容的源码更新。');
    }
    report.start('fetch');
    const git = (args) => execute('git', ['-C', stage, ...args], { env: commandEnvironment(), timeout: 180_000 });
    await git(['init']);
    await git(['remote', 'add', 'origin', repository]);
    await withNetworkRetry(() => execute('git', ['-C', stage, 'fetch', '--depth=1', 'origin',
      `refs/tags/${release.tag}:refs/tags/${release.tag}`,
      `refs/tags/v${info.version}:refs/tags/v${info.version}`],
    { env: commandEnvironment(), timeout: 180_000, onLine: report.output }), report);
    await git(['checkout', '--detach', release.tag]);
    const commit = await git(['rev-parse', 'HEAD']);
    const pkg = JSON.parse(await fs.readFile(path.join(stage, 'package.json'), 'utf8'));
    if (pkg.name !== 'codex-remote' || pkg.version !== release.version) throw new Error('Release version mismatch.');
    report.finish('fetch');
    report.start('compare');
    const files = (await git(['diff', '--name-only', '--no-renames', `v${info.version}`, release.tag])).split('\n').filter(Boolean);
    // Read only public source files. Runtime data never enters the update plan.
    const readBase = async (file) => {
      const exists = await git(['ls-tree', '--name-only', `v${info.version}`, '--', file]);
      if (!exists) return null;
      return Buffer.from(await execute('git', ['-C', stage, 'show', `v${info.version}:${file}`],
        { env: commandEnvironment(), timeout: 30_000, raw: true }));
    };
    // Binary-safe git blobs are read separately, with no trimming or transcoding.
    const plan = await planFiles(info.root, stage, files, readBase);
    const retained = plan.filter((item) => item.preserve);
    if (retained.length) report.note(`将保留 ${retained.length} 份本机文档，并保存新版副本供对照。`);
    for (const item of plan) item.before = hash(await regularFile(info.root, item.relative));
    const inputs = await mergeBuildInputs(info.root, stage, plan);
    const tools = await nodeToolchain(execute);
    cache = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-npm-'));
    // CLI configuration wins over project/user npmrc. The environment also
    // carries the same cache into lifecycle scripts and nested npm commands.
    for (const key of Object.keys(tools.env)) {
      if (key.toLowerCase() === 'npm_config_cache') delete tools.env[key];
    }
    tools.cache = cache;
    tools.env.npm_config_cache = cache;
    tools.env.npm_config_update_notifier = 'false';
    report.finish('compare');
    report.start('dependencies');
    await installDependencies(tools, stage, execute, report);
    report.finish('dependencies');
    for (const [key, args] of [['typecheck', ['run', 'typecheck']], ['test', ['test']], ['build', ['run', 'build']]]) {
      report.start(key);
      await execute(...npmCommand(tools, args, stage, report.output));
      report.finish(key);
    }
    report.start('offline');
    await installDependencies(tools, stage, execute, report, true);
    report.finish('offline');
    return { info, stage, plan, inputs, tools, commit, release, execute, report, mode: 'source' };
  } catch (error) {
    const cleaned = await removePreparation(stage, cache);
    const message = `${updateError(error)}\n尚未安装新版本，原有服务和文件保持原状。`;
    report.terminal('failed', '更新准备未完成',
      message + (cleaned ? '' : '\n部分临时文件未能清理，可稍后重试。'), error);
    throw new Error(message, { cause: error });
  }
}

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
