import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { run } from './process.mjs';
import { installation, commandEnvironment } from './controller.mjs';
import { createUpdateProgress, networkFailure, updateError } from './update-progress.mjs';

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

// Preparation is side-effect free for the live installation: fetch, compare and
// build in an isolated directory before any service is stopped.
export async function prepareUpdate(directory, release, progress, execute = run) {
  const info = await installation(directory);
  if (!versionPattern.test(release.tag) || compareVersions(release.tag, info.version) <= 0) {
    throw new Error('没有可安装的新版本，请重新检查版本。');
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-update-'));
  const report = createUpdateProgress(progress);
  let cache;
  try {
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
    return { info, stage, plan, inputs, tools, commit, release, execute, report };
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

export async function installUpdate(prepared, { stop, start, verify, isRunning, progress }) {
  const { info, stage, plan, tools, execute, release } = prepared;
  const backup = path.join(info.root, 'output', `manager-backup-${Date.now()}`);
  let touched = false;
  let stopped = false;
  let wasRunning = false;
  let dependenciesSaved = false;
  let result;
  const report = prepared.report || createUpdateProgress(progress);
  const checkInputs = async () => {
    for (const item of [...plan, ...(prepared.inputs || [])]) {
      if (hash(await regularFile(info.root, item.relative)) !== item.before) {
        throw new Error(`Installation changed during preparation: ${item.relative}`);
      }
    }
  };
  try {
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
        await fs.copyFile(path.join(stage, item.relative), path.join(backup, 'incoming', item.relative));
      }
    }
    for (const dir of ['dist', 'dist-server']) await copyTree(path.join(info.root, dir), path.join(backup, dir));
    await fs.writeFile(path.join(backup, 'receipt.json'), JSON.stringify({
      from: info.version, to: release.version, commit: prepared.commit, plan, wasRunning
    }, null, 2), 'utf8');
    report.finish('backup');
    report.start('stop');
    stopped = true;
    await stop();
    await checkInputs();
    report.finish('stop');
    report.start('install');
    try {
      await fs.rename(path.join(info.root, 'node_modules'), path.join(backup, 'node_modules'));
      dependenciesSaved = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    touched = true;
    for (const item of plan) {
      if (item.preserve) continue;
      const target = path.join(info.root, item.relative);
      if (item.remove) await fs.rm(target, { force: true });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(stage, item.relative), target);
      }
    }
    await copyTree(path.join(stage, 'dist'), path.join(info.root, 'dist'));
    await copyTree(path.join(stage, 'dist-server'), path.join(info.root, 'dist-server'));
    report.note('正在从已验证的本次缓存离线安装依赖；旧版依赖已保留供恢复。');
    await installDependencies(tools, info.root, execute, report, true);
    report.finish('install');
    report.start('verify');
    if (wasRunning) {
      await start();
      await verify();
    } else report.note('更新前服务处于关闭状态，本次保持关闭。');
    report.finish('verify');
    result = { version: release.version, backup, wasRunning, dependenciesSaved, edgeSyncRequired: Boolean(info.publicUrl),
      preservedFiles: plan.filter((item) => item.preserve).map((item) => item.relative) };
  } catch (error) {
    report.output(error.message);
    if (touched) {
      report.recovery('restore-files', '正在恢复旧版', 0, '安装未完成，正在停止本次服务并恢复备份文件。');
      try {
        await stop();
        for (const item of plan) {
          if (item.preserve) continue;
          const target = path.join(info.root, item.relative);
          const source = path.join(backup, 'source', item.relative);
          if (item.before) await fs.copyFile(source, target);
          else await fs.rm(target, { force: true });
        }
        for (const dir of ['dist', 'dist-server']) await copyTree(path.join(backup, dir), path.join(info.root, dir));
        report.recovery('restore-dependencies', '正在恢复旧版依赖', 40,
          dependenciesSaved ? '正在恢复原有依赖，无需连接网络。' : '原安装没有可用的依赖备份，正在安装旧版锁定依赖。');
        if (dependenciesSaved) {
          await fs.rm(path.join(info.root, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          await fs.rename(path.join(backup, 'node_modules'), path.join(info.root, 'node_modules'));
        } else await installDependencies(tools, info.root, execute, report);
        report.recovery('restore-service', '正在确认旧版状态', 85, '正在恢复更新前的服务状态并检查健康度。');
        if (wasRunning) { await start(); await verify(); }
      } catch (rollback) {
        const message = `新版本安装失败，自动恢复也未能完成，需要人工处理。\n备份位置：${backup}\n${updateError(rollback)}`;
        report.terminal('recovery-failed', '旧版恢复未完成', message, rollback);
        throw new Error(message, { cause: rollback });
      }
      const message = `新版本安装未完成，已恢复旧版和更新前的运行状态。\n${updateError(error)}`;
      report.terminal('recovered', '已恢复旧版', message);
      throw new Error(message, { cause: error });
    } else if (stopped && wasRunning) {
      report.recovery('resume-service', '正在恢复原有服务', 0, '尚未替换文件，正在恢复原有服务。');
      try { await start(); await verify(); }
      catch (recovery) {
        const message = `尚未替换安装文件，但原有服务未能恢复，需要人工检查。\n备份位置：${backup}\n${updateError(recovery)}`;
        report.terminal('recovery-failed', '服务恢复未完成', message, recovery);
        throw new Error(message, { cause: recovery });
      }
    }
    const message = `尚未替换安装文件，更新已停止。\n${updateError(error)}`;
    report.terminal('failed', '更新未完成', message);
    throw new Error(message, { cause: error });
  } finally {
    if (result) report.start('cleanup');
    const cleaned = await removePreparation(stage, tools.cache);
    if (result) {
      result.cleanupWarning = cleaned ? '' : '更新已完成，但部分临时文件未能清理，可稍后清理。';
      report.terminal('completed', '更新完成',
        result.cleanupWarning || (wasRunning ? '新版已安装，本机服务检查通过。' : '新版已安装，服务保持关闭。'));
    }
  }
  return result;
}
