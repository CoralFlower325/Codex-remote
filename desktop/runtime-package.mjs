import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { x as extract, t as list } from 'tar';

export const runtimeRepository = 'CoralFlower325/Codex-remote';
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
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
    !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{64}$/.test(manifest.archive?.sha256) ||
    !Number.isSafeInteger(manifest.archive?.size) || manifest.archive.size <= 0 ||
    manifest.archive.size > 512 * 1024 * 1024 || !manifest.files || !manifest.sources || !manifest.baselines) {
    throw new Error('运行包版本、平台或校验信息不匹配。');
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
    'node_modules/node-pty/package.json']) {
    if (!manifest.files[name]) throw new Error(`运行包缺少必要文件：${name}`);
  }
  for (const name of Object.keys(manifest.sources)) {
    if (!manifest.files[name]) throw new Error('运行包源码清单不完整。');
  }
  return manifest;
}

function assetUrl(asset) {
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
    !url.pathname.startsWith(`/${runtimeRepository}/releases/download/`) || url.username || url.password ||
    url.search || url.hash) throw new Error('运行包下载地址无效。');
  return url.href;
}

export async function downloadAsset(asset, target, { fetcher = fetch, progress = () => {} } = {}) {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024) {
    throw new Error('运行包下载大小无效。');
  }
  const expected = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '')?.[1];
  if (!expected) throw new Error('Release 缺少官方文件校验值，请等待发布完成。');
  const response = await fetcher(assetUrl(asset), { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`运行包下载失败（HTTP ${response.status}）。`);
  let size = 0;
  const hash = crypto.createHash('sha256');
  const file = await fs.open(target, 'wx');
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error('运行包下载大小超出清单。');
      hash.update(chunk); progress(size, asset.size);
      await file.writeFile(chunk);
    }
    await file.sync();
    if (size !== asset.size || hash.digest('hex') !== expected) throw new Error('运行包下载校验失败。');
  } finally { await file.close(); }
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
