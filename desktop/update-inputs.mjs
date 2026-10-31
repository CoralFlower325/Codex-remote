import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './process.mjs';
import { commandEnvironment } from './controller.mjs';
import { networkFailure } from './update-progress.mjs';
import { compareVersions } from './release.mjs';

export function safeRelative(file) {
  if (!file || file.includes('\\') || file.startsWith('/') ||
    file.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^(?:data|output|node_modules|\.git|\.env[^/]*)(?:\/|$)/i.test(file)) {
    throw new Error('The release contains a protected path.');
  }
  return file;
}

export async function regularFile(root, relative) {
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
  const { node, env } = await runtimeNode(execute);
  const npmPath = await execute(node, ['--input-type=module', '-e',
    'import fs from "node:fs";import path from "node:path";const n=process.execPath;const p=process.platform==="win32"?path.join(path.dirname(n),"node_modules/npm/bin/npm-cli.js"):fs.realpathSync(process.argv[1]);process.stdout.write(p);',
    ...(process.platform === 'win32' ? [] : [(await execute('/usr/bin/which', ['npm'], { env })).split('\n')[0]])], { env });
  return { node, npmPath, env };
}

export async function runtimeNode(execute) {
  const env = commandEnvironment();
  const found = await execute(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['node'], { env });
  const node = found.split(/\r?\n/)[0];
  const version = await execute(node, ['--version'], { env });
  if (compareVersions(version, '22.19.0') < 0) throw new Error('Node.js 22.19+ is required.');
  return { node, env };
}

export const hash = (bytes) => bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null;

export function npmCommand(tools, args, cwd, onLine) {
  return [tools.node, [tools.npmPath, '--cache', tools.cache, ...args],
    { cwd, env: tools.env, timeout: 600_000, onLine }];
}

export async function removePreparation(stage, cache) {
  const results = await Promise.allSettled([stage, cache].filter(Boolean)
    .map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })));
  return results.every((result) => result.status === 'fulfilled');
}

export async function withNetworkRetry(operation, report) {
  try { return await operation(); }
  catch (error) {
    if (!networkFailure(error)) throw error;
    report.output(error.message);
    report.note('网络连接中断，正在进行最后一次重试；已完成的更新进度保留。');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return operation();
  }
}

export function installDependencies(tools, cwd, execute, report, offline = false) {
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

export async function buildFileNames(root) {
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

