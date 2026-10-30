import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { c as archive } from 'tar';
import { sha256, sourceHash, runtimeNames, runtimePath, validateManifest, unpackRuntime, downloadAsset } from './runtime-package.mjs';
import { prepareUpdate, installUpdate } from './updater.mjs';

const temporary = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-runtime-'));
  temporary.push(root); return root;
}
async function write(root, name, bytes) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), bytes);
}
async function fixture() {
  const root = await directory(); const payload = await directory(); const output = await directory();
  const source = { 'package.json': JSON.stringify({ name: 'codex-remote', version: '0.1.14' }),
    'scripts/remote-control-windows.ps1': 'new controls',
    'scripts/remote-control-macos.sh': 'new controls',
    'scripts/check-runtime.mjs': '// runtime smoke',
    'src/main.ts': 'export const value = 1;' };
  const base = { ...source, 'package.json': JSON.stringify({ name: 'codex-remote', version: '0.1.13' }),
    'scripts/remote-control-windows.ps1': 'old controls', 'scripts/remote-control-macos.sh': 'old controls' };
  const binaries = { 'dist/client/index.html': 'new page', 'dist-server/server/index.js': 'new server',
    'node_modules/node-pty/package.json': '{}', 'node_modules/dependency/index.js': 'new dependency' };
  for (const [name, value] of Object.entries(base)) await write(root, name, value);
  await write(root, 'dist-server/server/index.js', 'old server');
  await write(root, 'dist/client/index.html', 'old page');
  await write(root, 'node_modules/working.txt', 'old dependency');
  await write(root, 'data/auth.json', 'private');
  const files = {};
  for (const [name, value] of Object.entries({ ...source, ...binaries })) {
    await write(payload, name, value);
    files[name] = { size: Buffer.byteLength(value), sha256: sha256(Buffer.from(value)), mode: 0o644 };
  }
  const filename = path.join(output, 'payload.tar.gz');
  await archive({ cwd: payload, file: filename, gzip: true, portable: true }, Object.keys(files));
  const bytes = await fs.readFile(filename);
  const manifest = { format: 1, repository: 'CoralFlower325/Codex-remote', version: '0.1.14',
    commit: 'a'.repeat(40), platform: process.platform, arch: process.arch, files,
    sources: Object.fromEntries(Object.entries(source).map(([name, value]) => [name, sourceHash(Buffer.from(value))])),
    baselines: { '0.1.13': Object.fromEntries(Object.entries(base).map(([name, value]) => [name, sourceHash(Buffer.from(value))])) },
    archive: { size: bytes.length, sha256: sha256(bytes) } };
  const names = runtimeNames('0.1.14');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const assets = [[names.manifest, manifestBytes], [names.archive, bytes]].map(([name, body]) =>
    ({ name, size: body.length, digest: `sha256:${sha256(body)}`,
      browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/v0.1.14/${name}` }));
  const fetcher = vi.fn(async (url) => new Response(url.endsWith('.json') ? manifestBytes : bytes));
  const execute = vi.fn(async (_command, args) => {
    if (args[0] === 'node') return 'node';
    if (args[0] === '--version') return 'v22.19.0';
    if (args[0] === 'scripts/check-runtime.mjs') return 'runtime smoke passed';
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  return { root, payload, output, filename, bytes, manifest, assets, fetcher, execute,
    release: { version: '0.1.14', tag: 'v0.1.14', assets } };
}
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('prebuilt runtime packages', () => {
  it('prepares and installs a verified runtime without Git, npm or a local build', async () => {
    const fixtureData = await fixture();
    const { root, release, fetcher, execute } = fixtureData;
    await write(root, 'README.md', 'private documentation');
    const progress = [];
    const item = await prepareUpdate(root, release, (_title, state) => progress.push(state), execute, { fetcher });
    expect(item.mode).toBe('runtime');
    const start = vi.fn();
    const result = await installUpdate(item, { stop: vi.fn(), start, verify: vi.fn(), isRunning: async () => false });
    expect(result.mode).toBe('runtime');
    expect(start).not.toHaveBeenCalled();
    expect(execute.mock.calls).toHaveLength(3);
    expect(await fs.readFile(path.join(root, 'node_modules/dependency/index.js'), 'utf8')).toBe('new dependency');
    expect(await fs.readFile(path.join(root, 'data/auth.json'), 'utf8')).toBe('private');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('private documentation');
    expect(progress.at(-1)).toMatchObject({ status: 'completed', percent: 100 });
    expect(progress.map((state) => state.percent)).toEqual(progress.map((state) => state.percent).sort((a, b) => a - b));
  });
  it('falls back to isolated source preparation for added local build inputs', async () => {
    const { root, release, fetcher } = await fixture();
    await write(root, 'src/custom.ts', 'local customization');
    const execute = vi.fn(async (command) => {
      expect(command).toBe('git'); throw new Error('source fallback selected');
    });
    await expect(prepareUpdate(root, release, () => {}, execute, { fetcher })).rejects.toThrow('尚未安装');
    expect(execute).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(root, 'src/custom.ts'), 'utf8')).toBe('local customization');
  });
  it('blocks an added build input during download before stopping service', async () => {
    const { root, release, fetcher, execute } = await fixture();
    const item = await prepareUpdate(root, release, () => {}, execute, { fetcher });
    await write(root, 'src/added-during-download.ts', 'new local customization');
    const stop = vi.fn();
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(), isRunning: async () => false }))
      .rejects.toThrow('尚未替换');
    expect(stop).not.toHaveBeenCalled();
  });
  it('rejects incomplete releases and corrupt downloads before changing the installation', async () => {
    const { root, release, execute, fetcher, assets, output } = await fixture();
    await expect(prepareUpdate(root, { ...release, assets: assets.slice(0, 1) }, () => {}, execute, { fetcher }))
      .rejects.toThrow('尚未安装');
    await expect(downloadAsset(assets[1], path.join(output, 'bad'), {
      fetcher: async () => new Response(Buffer.alloc(assets[1].size, 0))
    })).rejects.toThrow('校验失败');
    expect(await fs.readFile(path.join(root, 'dist-server/server/index.js'), 'utf8')).toBe('old server');
  });
  it('verifies every extracted file and rejects an incompatible platform', async () => {
    const { output, filename, manifest } = await fixture();
    expect(() => validateManifest({ ...manifest, platform: 'invalid' }, { version: '0.1.14' })).toThrow();
    manifest.files['dist/client/index.html'].sha256 = '0'.repeat(64);
    await expect(unpackRuntime(filename, path.join(output, 'unpacked'), manifest)).rejects.toThrow('校验失败');
  });
  it('refuses archive links and duplicates before extraction', async () => {
    const { payload, output, manifest } = await fixture();
    await fs.symlink(path.join(payload, 'src'), path.join(payload, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = path.join(output, 'linked.tar.gz');
    await archive({ cwd: payload, file: linked, gzip: true }, ['linked']);
    await expect(unpackRuntime(linked, path.join(output, 'no-extract'), manifest)).rejects.toThrow();
    await expect(fs.access(path.join(output, 'no-extract'))).rejects.toThrow();
    const duplicate = path.join(output, 'duplicate.tar.gz');
    await archive({ cwd: payload, file: duplicate, gzip: true }, ['package.json', 'package.json']);
    await expect(unpackRuntime(duplicate, path.join(output, 'no-duplicates'), manifest)).rejects.toThrow();
  });
  it.each(['../x', '/tmp/x', 'a\\x', 'a/C:', 'a/NUL.txt', 'a/x.', 'data/auth.json', '.env'])('rejects unsafe package path %s', (name) => {
    expect(() => runtimePath(name)).toThrow();
  });
});
