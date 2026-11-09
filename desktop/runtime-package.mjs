import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { x as extract, t as list } from 'tar';
import { assetEndpoints } from './release-source.mjs';
import { releaseRepository } from './release-identity.mjs';

export const runtimeRepository = releaseRepository;
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const testedRuntimeNodeMajorMinor = '22.19';

export function runtimeNodeAbi(version = process.versions.node, modules = process.versions.modules) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  if (!match || !/^\d+$/.test(String(modules))) throw new Error('运行包 Node ABI 信息无效。');
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    majorMinor: `${Number(match[1])}.${Number(match[2])}`,
    modules: String(modules)
  };
}

export function assertTestedRuntimeNode(runtime = runtimeNodeAbi()) {
  if (runtime.majorMinor !== testedRuntimeNodeMajorMinor) {
    throw new Error(`运行包必须在受测 Node ${testedRuntimeNodeMajorMinor}.x 下构建，`
      + `当前为 ${runtime.version}（ABI ${runtime.modules}）。`);
  }
  return runtime;
}

export function assertManifestRuntimeNode(manifest, runtime = runtimeNodeAbi()) {
  const required = manifest?.node;
  if (!required || required.majorMinor !== runtime.majorMinor || required.modules !== runtime.modules) {
    throw new Error(`运行包需要 Node ${required?.majorMinor ?? '未知'}（ABI ${required?.modules ?? '未知'}），`
      + `当前为 ${runtime.version}（ABI ${runtime.modules}）。请使用匹配的 Node 运行，或改用源码更新。`);
  }
  return required;
}

export function sourceHash(bytes) {
  let content = bytes;
  if (!bytes.includes(0)) {
    try { content = Buffer.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n')); }
    catch {}
  }
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}
export function runtimeNames(version, platform = process.platform, arch = process.arch) {
  const stem = `codex-remote-runtime-${version}-${platform}-${arch}`;
  return { manifest: `${stem}.json`, archive: `${stem}.tar.gz` };
}
export function runtimePath(relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) ||
    /^(?:data|output|\.git|\.env[^/]*)(?:\/|$)/i.test(relative)) {
    throw new Error('运行包包含不安全的路径。');
  }
  return relative;
}
export function validateManifest(manifest, release, platform = process.platform, arch = process.arch) {
  if (manifest?.format !== 1 || manifest.repository !== runtimeRepository ||
    manifest.version !== release.version || manifest.platform !== platform || manifest.arch !== arch ||
    !manifest.node || typeof manifest.node !== 'object' ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{64}$/.test(manifest.archive?.sha256) ||
    !Number.isSafeInteger(manifest.archive?.size) || manifest.archive.size <= 0 ||
    manifest.archive.size > 512 * 1024 * 1024 || !manifest.files || !manifest.sources || !manifest.baselines) {
    throw new Error('运行包版本、平台或校验信息不匹配。');
  }
  const node = runtimeNodeAbi(manifest.node.version, manifest.node.modules);
  if (manifest.node.majorMinor !== node.majorMinor) {
    throw new Error('运行包 Node ABI 信息不一致。');
  }
  const files = Object.entries(manifest.files);
  if (!files.length || files.length > 100_000) throw new Error('运行包文件数量无效。');
  let total = 0;
  const folded = new Set();
  for (const [name, entry] of files) {
    runtimePath(name);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      ![0o644, 0o755].includes(entry.mode) || folded.has(name.toLowerCase())) {
      throw new Error('运行包文件清单无效。');
    }
    folded.add(name.toLowerCase());
    total += entry.size;
  }
  if (total > 1536 * 1024 * 1024) throw new Error('运行包解压大小超出限制。');
  for (const sources of [manifest.sources, ...Object.values(manifest.baselines)]) {
    if (typeof sources !== 'object' || !sources || Object.keys(sources).length > 20_000) throw new Error('源码基线无效。');
    for (const [name, value] of Object.entries(sources)) {
      runtimePath(name);
      if (name.startsWith('node_modules/') || !/^[a-f0-9]{40}$/.test(value)) throw new Error('源码基线无效。');
    }
  }
  for (const name of ['package.json', 'dist/client/index.html', 'dist-server/server/index.js',
    'node_modules/node-pty/package.json', 'scripts/terminal-job-windows.ps1']) {
    if (!manifest.files[name]) throw new Error(`运行包缺少必要文件：${name}`);
  }
  for (const name of Object.keys(manifest.sources)) {
    if (!manifest.files[name]) throw new Error('运行包源码清单不完整。');
  }
  return manifest;
}

export async function downloadAsset(asset, target, { fetcher = fetch, progress = () => {} } = {}) {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024) {
    throw new Error('运行包下载大小无效。');
  }
  const expected = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '')?.[1];
  if (!expected) throw new Error('Release 缺少官方文件校验值，请等待发布完成。');
  let failure;
  for (const endpoint of assetEndpoints(asset)) {
    try {
      await downloadAttempt(endpoint, target, asset, expected, fetcher, progress);
      return;
    } catch (error) {
      // A caller-owned existing file is never removed or retried.
      if (error.code === 'EEXIST') throw error;
      failure = error;
    }
  }
  throw failure;
}

async function downloadAttempt(endpoint, target, asset, expected, fetcher, progress) {
  const response = await fetcher(endpoint, { signal: AbortSignal.timeout(600_000),
    redirect: endpoint.startsWith('https://github.com/') ? 'follow' : 'error' });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`运行包下载失败（HTTP ${response.status}）。`);
  }
  let size = 0;
  const hash = crypto.createHash('sha256');
  let file;
  try {
    file = await fs.open(target, 'wx');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error('运行包下载大小超出清单。');
      hash.update(chunk); progress(size, asset.size);
      await file.writeFile(chunk);
    }
    await file.sync();
    if (size !== asset.size || hash.digest('hex') !== expected) throw new Error('运行包下载校验失败。');
  } catch (error) {
    if (file) {
      await file.close(); file = null;
      await fs.rm(target, { force: true });
    }
    await response.body.cancel().catch(() => {});
    throw error;
  } finally { await file?.close(); }
}

export async function unpackRuntime(archive, destination, manifest) {
  const seen = new Set();
  let invalid = '';
  // Validate the entire archive before extracting anything, including links,
  // duplicate paths, entry sizes and Windows path aliases.
  await list({ file: archive, strict: true, onReadEntry(entry) {
    try {
      const name = runtimePath(entry.path.replace(/\/$/, ''));
      if (entry.type === 'Directory') return;
      const expected = manifest.files[name];
      if (entry.type !== 'File' || !expected || expected.size !== entry.size || seen.has(name.toLowerCase())) {
        throw new Error('运行包归档与清单不一致。');
      }
      seen.add(name.toLowerCase());
    } catch (error) { invalid ||= error.message; }
  } });
  if (invalid || seen.size !== Object.keys(manifest.files).length) {
    throw new Error(invalid || '运行包归档缺少文件。');
  }
  await fs.mkdir(destination);
  await extract({ file: archive, cwd: destination, strict: true, preservePaths: false,
    noChmod: true, noMtime: true, filter: (_name, entry) => entry.type === 'File' || entry.type === 'Directory' });
  for (const [name, expected] of Object.entries(manifest.files)) {
    const target = path.join(destination, name);
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== expected.sha256) throw new Error(`运行包文件校验失败：${name}`);
    await fs.chmod(target, expected.mode);
  }
}
