import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { c as archive } from 'tar';
import { runtimeNames, runtimePath, sha256, runtimeRepository, sourceHash } from '../desktop/runtime-package.mjs';

const git = (...args) => execFileSync('git', args, { maxBuffer: 16 * 1024 * 1024 }).toString('utf8').trim();
export function treeSources(ref) {
  const result = {};
  for (const row of git('ls-tree', '-rz', ref).split('\0').filter(Boolean)) {
    const [metadata, name] = row.split('\t');
    if (/^\.env|^(?:data|output|node_modules|\.git)(?:\/|$)/i.test(name)) continue;
    runtimePath(name);
    const [mode, type, blob] = metadata.split(' ');
    if (type !== 'blob' || mode === '120000') throw new Error(`Unsupported source entry: ${name}`);
    result[name] = blob;
  }
  return result;
}
export async function packageRuntime(root, output) {
  if (!['win32-x64', 'darwin-arm64'].includes(`${process.platform}-${process.arch}`)) {
    throw new Error('Runtime packages support Windows x64 and Apple Silicon.');
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const sources = treeSources('HEAD');
  const stage = await fs.mkdtemp(path.join(output, 'runtime-stage-'));
  try {
    for (const [name, expected] of Object.entries(sources)) {
      const bytes = await fs.readFile(path.join(root, name));
      if (sourceHash(bytes) !== expected) throw new Error(`Source differs from commit: ${name}`);
      await fs.mkdir(path.dirname(path.join(stage, name)), { recursive: true });
      await fs.copyFile(path.join(root, name), path.join(stage, name));
    }
    for (const directory of ['dist', 'dist-server', 'node_modules']) {
      await fs.cp(path.join(root, directory), path.join(stage, directory), {
        recursive: true, dereference: false, filter: (source) => !source.split(path.sep).includes('.bin')
      });
    }
    const files = {};
    async function visit(relative = '') {
      for (const entry of await fs.readdir(path.join(stage, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        runtimePath(name);
        if (entry.isDirectory()) await visit(name);
        else {
          if (!entry.isFile()) throw new Error(`Unsupported runtime entry: ${name}`);
          const target = path.join(stage, name);
          const stat = await fs.stat(target);
          files[name] = { size: stat.size, sha256: sha256(await fs.readFile(target)),
            mode: stat.mode & 0o111 ? 0o755 : 0o644 };
        }
      }
    }
    await visit();
    const baselines = {};
    for (const tag of git('tag', '--sort=-v:refname').split('\n')
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag) && tag !== `v${pkg.version}`).slice(0, 30)) {
      baselines[tag.slice(1)] = treeSources(tag);
    }
    const names = runtimeNames(pkg.version);
    const archivePath = path.join(output, names.archive);
    await archive({ file: archivePath, cwd: stage, gzip: true, portable: true, noMtime: true },
      Object.keys(files).sort());
    const bytes = await fs.readFile(archivePath);
    const manifest = { format: 1, repository: runtimeRepository, version: pkg.version,
      commit: git('rev-parse', 'HEAD'), platform: process.platform, arch: process.arch,
      node: process.versions.node, sources, baselines, files,
      archive: { size: bytes.length, sha256: sha256(bytes) } };
    await fs.writeFile(path.join(output, names.manifest), JSON.stringify(manifest), 'utf8');
    console.log(`Packaged ${names.archive} (${bytes.length} bytes)`);
    return manifest;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve('output/runtime');
  await fs.mkdir(output, { recursive: true });
  await packageRuntime(process.cwd(), output);
}
