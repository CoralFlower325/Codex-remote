import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { c as archive } from 'tar';
import { prepareUpdate } from './update-prepare.mjs';
import { buildFileNames, mergeBuildInputs } from './update-inputs.mjs';
import { runtimeNames, sha256, sourceHash } from './runtime-package.mjs';
import { signedFixture, signedSourceRelease } from '../scripts/test-release-signing.mjs';

const temporary = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-prepare-'));
  temporary.push(root);
  return root;
}
async function write(root, name, text) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), text);
}
async function fixture({ baseline = true, baseFiles = {}, targetFiles = {} } = {}) {
  const root = await directory(), payload = await directory(), output = await directory();
  const base = {
    'package.json': JSON.stringify({ name: 'codex-remote', version: '0.2.7' }),
    'src/main.ts': 'export const value = 1;',
    'scripts/remote-control-windows.ps1': 'controls',
    'scripts/remote-control-macos.sh': 'controls',
    ...baseFiles
  };
  const sources = { ...base, 'package.json': JSON.stringify({ name: 'codex-remote', version: '0.2.9' }),
    ...targetFiles };
  const bytes = { ...sources, 'dist/client/index.html': 'page',
    'dist-server/server/index.js': 'server', 'node_modules/node-pty/package.json': '{}' };
  for (const [name, text] of Object.entries(base)) await write(root, name, text);
  await write(root, 'dist-server/server/index.js', 'old server');
  for (const [name, text] of Object.entries(bytes)) await write(payload, name, text);
  const filename = path.join(output, 'runtime.tar.gz');
  await archive({ file: filename, cwd: payload, gzip: true, portable: true }, Object.keys(bytes));
  const archiveBytes = await fs.readFile(filename);
  const hashes = (values) => Object.fromEntries(Object.entries(values)
    .map(([name, text]) => [name, sourceHash(Buffer.from(text))]));
  const manifest = { format: 1, repository: 'CoralFlower325/Codex-remote', version: '0.2.9',
    platform: process.platform, arch: process.arch, commit: 'a'.repeat(40),
    sources: hashes(sources), baselines: baseline ? { '0.2.7': hashes(base) } : {},
    files: Object.fromEntries(Object.entries(bytes).map(([name, text]) => [name, {
      size: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)), mode: 0o644 }])),
    archive: { size: archiveBytes.length, sha256: sha256(archiveBytes) } };
  const { signed, keys } = signedFixture(manifest);
  const names = runtimeNames('0.2.9'), manifestBytes = Buffer.from(JSON.stringify(signed));
  const assets = [[names.manifest, manifestBytes], [names.archive, archiveBytes]].map(([name, body]) => ({
    name, size: body.length, digest: `sha256:${sha256(body)}`,
    browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/${name}`
  }));
  const execute = vi.fn(async (command, args) => {
    if (command === 'git') throw new Error('Synthetic source preparation stop.');
    if (args[0] === 'node') return 'node';
    if (args[0] === '--version') return 'v22.19.0';
    if (args[0] === 'scripts/check-runtime.mjs') return 'checked';
    throw new Error(`Unexpected command: ${command}`);
  });
  const fetcher = vi.fn(async (url) => new Response(url.endsWith('.json') ? manifestBytes : archiveBytes));
  const states = [];
  const progress = (_message, state) => states.push(state);
  return { root, execute, fetcher, states, progress, trustedKeys: keys, manifest: signed, manifestBytes,
    release: { tag: 'v0.2.9', version: '0.2.9', assets } };
}
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('runtime preparation input classification', () => {
  it.each(['src/main.ts', 'scripts/update.mjs', 'package-lock.json', 'tsconfig.client.json', 'vite.config.ts'])(
    'accepts an already applied target %s without source fallback', async relative => {
      const item = await fixture({ baseFiles: { [relative]: 'old official\n' },
        targetFiles: { [relative]: 'new official\n' } });
      await write(item.root, relative, 'new official\r\n');
      const prepared = await prepareUpdate(item.root, item.release, item.progress, item.execute,
        { fetcher: item.fetcher, trustedKeys: item.trustedKeys });
      temporary.push(prepared.stage);
      expect(prepared.mode).toBe('runtime');
      expect(prepared.plan.some((entry) => entry.relative === relative)).toBe(false);
      expect(prepared.inputs.some((entry) => entry.relative === relative)).toBe(true);
      expect(item.execute.mock.calls.some(([command]) => command === 'git')).toBe(false);
    });

  it.each(['package.json', 'package-lock.json', 'tsconfig.client.json', 'vite.config.ts'])(
    'retains genuinely customized %s instead of replacing it with a runtime package', async relative => {
      const item = await fixture(relative === 'package.json' ? {} : {
        baseFiles: { [relative]: 'old official configuration' },
        targetFiles: { [relative]: 'new official configuration' }
      });
      const local = relative === 'package.json'
        ? JSON.stringify({ name: 'codex-remote', version: '0.2.7', scripts: { private: 'private command' } })
        : 'private build configuration';
      await write(item.root, relative, local);
      await expect(prepareUpdate(item.root, item.release, item.progress, item.execute,
        { fetcher: item.fetcher, trustedKeys: item.trustedKeys }))
        .rejects.toMatchObject({ cause: { message: 'Synthetic source preparation stop.' } });
      expect(await fs.readFile(path.join(item.root, relative), 'utf8')).toBe(local);
      expect(item.states.map((state) => state.detail).join('\n')).toContain(relative);
      expect(item.fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a standard installation on runtime despite Finder and AppleDouble metadata', async () => {
    const item = await fixture();
    const metadata = ['scripts/.DS_Store', 'src/nested/._main.ts',
      'public/__MACOSX/asset', 'scripts/._directory/nested'];
    for (const name of metadata) await write(item.root, name, 'mac metadata');
    const prepared = await prepareUpdate(item.root, item.release, item.progress, item.execute,
      { fetcher: item.fetcher, trustedKeys: item.trustedKeys });
    temporary.push(prepared.stage);
    expect(prepared.mode).toBe('runtime');
    expect(item.execute.mock.calls.some(([command]) => command === 'git')).toBe(false);
    for (const name of metadata) expect(prepared.runtimeFiles).not.toContain(name);
    for (const name of metadata) expect(await fs.readFile(path.join(item.root, name), 'utf8')).toBe('mac metadata');
  });

  it('uses the same metadata exclusions when merging source inputs and retains actual custom files', async () => {
    const root = await directory(), stage = await directory();
    const metadata = ['src/.DS_Store', 'public/._asset.png', 'scripts/__MACOSX/._script'];
    for (const name of metadata) {
      await write(root, name, 'local metadata');
      await write(stage, name, 'incoming metadata');
    }
    await write(root, 'src/custom.ts', 'private customization');
    await write(root, 'scripts/.custom.mjs', 'real hidden source');
    const inputs = await mergeBuildInputs(root, stage, []);
    expect(inputs.map(({ relative }) => relative).sort()).toEqual(await buildFileNames(root));
    expect(inputs.map(({ relative }) => relative).sort()).toEqual(['scripts/.custom.mjs', 'src/custom.ts']);
    expect(await fs.readFile(path.join(stage, 'src/custom.ts'), 'utf8')).toBe('private customization');
    expect(await fs.readFile(path.join(stage, 'scripts/.custom.mjs'), 'utf8')).toBe('real hidden source');
    for (const name of metadata) expect(await fs.readFile(path.join(stage, name), 'utf8')).toBe('incoming metadata');
  });

  it.each(['modified', 'deleted'])('reports the tracked path for %s source without exposing its contents', async (kind) => {
    const item = await fixture();
    if (kind === 'modified') await write(item.root, 'src/main.ts', 'SECRET_LOCAL_CONTENT');
    else await fs.rm(path.join(item.root, 'src/main.ts'));
    await expect(prepareUpdate(item.root, item.release, item.progress, item.execute,
      { fetcher: item.fetcher, trustedKeys: item.trustedKeys }))
      .rejects.toMatchObject({ cause: { message: 'Synthetic source preparation stop.' } });
    const details = item.states.map((state) => state.detail).join('\n');
    expect(details).toContain('src/main.ts');
    expect(details).not.toContain('SECRET_LOCAL_CONTENT');
    expect(details).not.toContain(item.root);
  });

  it('bounds added customization diagnostics and retains every local file', async () => {
    const item = await fixture();
    for (let i = 0; i < 12; i++) await write(item.root, `src/custom-${String(i).padStart(2, '0')}.ts`, 'private code');
    await expect(prepareUpdate(item.root, item.release, item.progress, item.execute,
      { fetcher: item.fetcher, trustedKeys: item.trustedKeys }))
      .rejects.toMatchObject({ cause: { message: 'Synthetic source preparation stop.' } });
    const detail = item.states.find((state) => state.detail.includes('src/custom-'))?.detail;
    expect(detail).toContain('src/custom-07.ts');
    expect(detail).not.toContain('src/custom-08.ts');
    expect(detail).not.toContain('private code');
    expect(detail).toContain('4');
    expect(item.states.at(-1).logs.some(({ message }) => message.includes('src/custom-07.ts'))).toBe(true);
    expect((await buildFileNames(item.root)).filter((name) => name.startsWith('src/custom-'))).toHaveLength(12);
  });

  it('explains an absent baseline before selecting the authenticated source route', async () => {
    const item = await fixture({ baseline: false });
    await expect(prepareUpdate(item.root, item.release, item.progress, item.execute,
      { fetcher: item.fetcher, trustedKeys: item.trustedKeys }))
      .rejects.toMatchObject({ cause: { message: 'Synthetic source preparation stop.' } });
    const details = item.states.map((state) => state.detail).join('\n');
    expect(details).toContain('0.2.7');
    expect(item.fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects absent signed assets without falling back to unauthenticated source or changing live files', async () => {
    const item = await fixture();
    await expect(prepareUpdate(item.root, { ...item.release, assets: [] }, item.progress, item.execute,
      { fetcher: item.fetcher, trustedKeys: item.trustedKeys })).rejects.toThrow('签名');
    expect(item.execute).not.toHaveBeenCalled();
    expect(item.fetcher).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(item.root, 'dist-server/server/index.js'), 'utf8')).toBe('old server');
    expect(item.states.at(-1).status).toBe('failed');
  });

  it.each(['missing', 'tampered', 'untrusted'])('blocks a %s manifest before runtime execution or live changes', async kind => {
    const item = await fixture();
    let manifest = item.manifest;
    if (kind === 'missing') { const { signature: _signature, ...unsigned } = manifest; manifest = unsigned; }
    if (kind === 'tampered') manifest = { ...manifest, archive: { ...manifest.archive, sha256: '0'.repeat(64) } };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const release = { ...item.release, assets: item.release.assets.map(asset => asset.name.endsWith('.json')
      ? { ...asset, size: bytes.length, digest: `sha256:${sha256(bytes)}` } : asset) };
    const fetcher = vi.fn(async () => new Response(bytes));
    await expect(prepareUpdate(item.root, release, item.progress, item.execute,
      { fetcher, trustedKeys: kind === 'untrusted' ? {} : item.trustedKeys })).rejects.toThrow('签名');
    expect(item.execute).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(item.root, 'dist-server/server/index.js'), 'utf8')).toBe('old server');
    expect(JSON.parse(await fs.readFile(path.join(item.root, 'package.json'), 'utf8')).version).toBe('0.2.7');
  });

  it('blocks a source tag whose commit differs from its authenticated release identity before any build', async () => {
    const item = await fixture();
    const identity = signedSourceRelease('0.2.9');
    const execute = vi.fn(async (command, args) => {
      expect(command).toBe('git');
      return args[2] === 'rev-parse' ? 'b'.repeat(40) : '';
    });
    await expect(prepareUpdate(item.root, identity.release, item.progress, execute, identity.options))
      .rejects.toThrow('提交与发布者签名不一致');
    expect(execute.mock.calls.map(([, args]) => args[2])).toEqual(['init', 'remote', 'fetch', 'checkout', 'rev-parse']);
    expect(await fs.readFile(path.join(item.root, 'dist-server/server/index.js'), 'utf8')).toBe('old server');
    expect(JSON.parse(await fs.readFile(path.join(item.root, 'package.json'), 'utf8')).version).toBe('0.2.7');
  });
});
