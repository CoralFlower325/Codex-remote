import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { compareVersions, latestRelease, safeRelative, planFiles, mergeBuildInputs, installUpdate, prepareUpdate } from './updater.mjs';

const temporary = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-manager-test-'));
  temporary.push(root);
  return root;
}
async function write(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text, 'utf8');
}
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('release selection', () => {
  it('compares numeric stable versions and treats same/newer installs as current', async () => {
    expect(compareVersions('0.1.10', 'v0.1.9')).toBe(1);
    expect(compareVersions('0.1.10', 'v0.1.10')).toBe(0);
    expect(() => compareVersions('../main', '0.1.9')).toThrow();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.1.10', body: 'Summary' }) });
    expect((await latestRelease('0.1.10', fetcher)).available).toBe(false);
    expect((await latestRelease('0.1.11', fetcher)).available).toBe(false);
    expect((await latestRelease('0.1.9', fetcher)).notes).toBe('Summary');
  });
  it('rejects failed API reads and non-stable releases', async () => {
    await expect(latestRelease('0.1.9', async () => ({ ok: false, status: 429 }))).rejects.toThrow('429');
    await expect(latestRelease('0.1.9', async () => ({ ok: true, json: async () => ({ tag_name: 'v0.2.0', prerelease: true }) }))).rejects.toThrow();
  });
});
describe('update file plan', () => {
  it.each(['../data/auth.json', '/tmp/file', '.env', '.env.local', 'data/auth.json',
    'node_modules/a', 'output/a', '.git/config', 'src\\a', 'src/../x'])('rejects protected path %s', (file) => {
    expect(() => safeRelative(file)).toThrow();
  });
  it('updates changed upstream files while preserving unrelated local customizations', async () => {
    const root = await directory(); const stage = await directory();
    await write(root, 'src/a.ts', 'old\r\n');
    await write(stage, 'src/a.ts', 'new\n');
    await write(root, 'src/private.ts', 'local customization');
    await write(root, 'data/auth.json', 'private');
    const plan = await planFiles(root, stage, ['src/a.ts'], async () => Buffer.from('old\n'));
    expect(plan).toEqual([{ relative: 'src/a.ts', remove: false }]);
    expect(await fs.readFile(path.join(root, 'data/auth.json'), 'utf8')).toBe('private');
  });
  it('blocks local edits, unexpected additions and local deletions', async () => {
    const root = await directory(); const stage = await directory();
    await write(root, 'a', 'private'); await write(stage, 'a', 'new');
    await expect(planFiles(root, stage, ['a'], async () => Buffer.from('old'))).rejects.toThrow('a');
    await expect(planFiles(root, stage, ['a'], async () => null)).rejects.toThrow('a');
    await write(stage, 'gone', 'new');
    await expect(planFiles(root, stage, ['gone'], async () => Buffer.from('old'))).rejects.toThrow('gone');
  });
  it('rejects a junction/symlink crossing the installation boundary', async () => {
    const root = await directory(); const stage = await directory(); const outside = await directory();
    await fs.symlink(outside, path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(planFiles(root, stage, ['src/a'], async () => null)).rejects.toThrow('Unsafe');
  });
  it('builds incoming changes together with unrelated local customizations and deletions', async () => {
    const root = await directory(); const stage = await directory();
    await write(root, 'src/custom.ts', 'private source');
    await write(root, 'src/new-local.ts', 'local module');
    await write(root, 'src/changed.ts', 'old release');
    await write(stage, 'src/custom.ts', 'official source');
    await write(stage, 'src/deleted.ts', 'deleted locally');
    await write(stage, 'src/changed.ts', 'incoming release');
    await write(root, '.env', 'private runtime');
    const inputs = await mergeBuildInputs(root, stage, [{ relative: 'src/changed.ts' }]);
    expect(await fs.readFile(path.join(stage, 'src/custom.ts'), 'utf8')).toBe('private source');
    expect(await fs.readFile(path.join(stage, 'src/new-local.ts'), 'utf8')).toBe('local module');
    expect(await fs.readFile(path.join(stage, 'src/changed.ts'), 'utf8')).toBe('incoming release');
    await expect(fs.access(path.join(stage, 'src/deleted.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(stage, '.env'))).rejects.toThrow();
    expect(inputs.some((item) => item.relative === 'src/new-local.ts')).toBe(true);
  });
  it('rejects linked local build inputs', async () => {
    const root = await directory(); const stage = await directory(); const outside = await directory();
    await fs.symlink(outside, path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(mergeBuildInputs(root, stage, [])).rejects.toThrow('Unsafe build input');
  });
});
async function prepared() {
  const root = await directory(); const stage = await directory();
  for (const base of [root, stage]) {
    await write(base, 'dist/client/index.html', base === root ? 'old' : 'new');
    await write(base, 'dist-server/server/index.js', base === root ? 'old' : 'new');
  }
  await write(root, 'data/auth.json', 'private');
  return { info: { root, version: '0.1.9', publicUrl: '' }, stage, plan: [],
    tools: { node: 'node', npmPath: 'npm-cli.js', env: {} }, commit: 'abc',
    release: { version: '0.1.10' }, execute: vi.fn().mockResolvedValue('') };
}
describe('installation transaction', () => {
  it('backs up before stopping, installs, restarts and verifies without touching private data', async () => {
    const item = await prepared(); const calls = [];
    const result = await installUpdate(item, {
      stop: async () => { expect(await fs.readFile(path.join(item.info.root, 'output',
        (await fs.readdir(path.join(item.info.root, 'output')))[0], 'receipt.json'), 'utf8')).toContain('0.1.10'); calls.push('stop'); },
      start: async () => { calls.push('start'); },
      verify: async () => { calls.push('verify'); }, isRunning: async () => true, progress: () => {}
    });
    expect(calls).toEqual(['stop', 'start', 'verify']);
    expect(await fs.readFile(path.join(item.info.root, 'dist/client/index.html'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(item.info.root, 'data/auth.json'), 'utf8')).toBe('private');
    expect(await fs.readFile(path.join(result.backup, 'dist/client/index.html'), 'utf8')).toBe('old');
  });
  it('preserves explicitly stopped state after an update', async () => {
    const item = await prepared(); const start = vi.fn();
    const result = await installUpdate(item, { stop: vi.fn(), start, verify: vi.fn(),
      isRunning: async () => false, progress: () => {} });
    expect(start).not.toHaveBeenCalled();
    expect(result.wasRunning).toBe(false);
  });
  it('restores old builds and dependencies after a failed startup', async () => {
    const item = await prepared();
    const verify = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValueOnce(undefined);
    await expect(installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify,
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('restored');
    expect(await fs.readFile(path.join(item.info.root, 'dist/client/index.html'), 'utf8')).toBe('old');
    expect(item.execute).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it('blocks changed live files before stopping the service', async () => {
    const item = await prepared(); const stop = vi.fn();
    await write(item.info.root, 'source.txt', 'new local edit');
    item.plan = [{ relative: 'source.txt', before: 'previous hash', remove: false }];
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('changed');
    expect(stop).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(item.info.root, 'source.txt'), 'utf8')).toBe('new local edit');
  });
  it('blocks a preserved build input changed during preparation', async () => {
    const item = await prepared(); const stop = vi.fn();
    await write(item.info.root, 'src/custom.ts', 'edited after build');
    item.inputs = [{ relative: 'src/custom.ts', before: 'previous hash' }];
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('changed');
    expect(stop).not.toHaveBeenCalled();
  });
  it('recovers changed and newly added sources after a failed dependency install', async () => {
    const item = await prepared();
    await write(item.info.root, 'source.txt', 'old source');
    await write(item.stage, 'source.txt', 'new source');
    await write(item.stage, 'addition.txt', 'new file');
    item.plan = [
      { relative: 'source.txt', before: crypto.createHash('sha256').update('old source').digest('hex'), remove: false },
      { relative: 'addition.txt', before: null, remove: false }
    ];
    item.execute.mockRejectedValueOnce(new Error('dependency failure')).mockResolvedValueOnce('');
    await expect(installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('restored');
    expect(await fs.readFile(path.join(item.info.root, 'source.txt'), 'utf8')).toBe('old source');
    await expect(fs.access(path.join(item.info.root, 'addition.txt'))).rejects.toThrow();
  });
  it('refuses linked backup directories before changing the live installation', async () => {
    const item = await prepared(); const outside = await directory(); const stop = vi.fn();
    await fs.symlink(outside, path.join(item.info.root, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('Unsafe');
    expect(stop).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('isolated update preparation', () => {
  it('finishes preflight and validation before live changes, removing a failed stage', async () => {
    const root = await directory();
    await write(root, 'package.json', JSON.stringify({ name: 'codex-remote', version: '0.1.9' }));
    await write(root, 'dist-server/server/index.js', 'old build');
    for (const file of ['remote-control-windows.ps1', 'remote-control-macos.sh']) await write(root, `scripts/${file}`, 'old control');
    await write(root, 'source.txt', 'old source');
    let stage;
    const execute = vi.fn(async (file, args) => {
      if (file === 'git') {
        stage = args[1];
        if (args[2] === 'checkout') {
          await write(stage, 'package.json', JSON.stringify({ name: 'codex-remote', version: '0.1.10' }));
          await write(stage, 'source.txt', 'new source');
        }
        if (args[2] === 'rev-parse') return 'release commit';
        if (args[2] === 'diff' || args[2] === 'ls-tree') return 'source.txt';
        if (args[2] === 'show') return Buffer.from('old source');
        return '';
      }
      if (file === 'where.exe' || file === '/usr/bin/which') return 'node';
      if (args[0] === '--version') return 'v22.19.0';
      if (args[0] === '--input-type=module') return 'npm-cli.js';
      if (args.includes('typecheck')) throw new Error('validation failure');
      return '';
    });
    await expect(prepareUpdate(root, { tag: 'v0.1.10', version: '0.1.10' }, () => {}, execute)).rejects.toThrow('validation failure');
    expect(await fs.readFile(path.join(root, 'source.txt'), 'utf8')).toBe('old source');
    expect(await fs.readFile(path.join(root, 'dist-server/server/index.js'), 'utf8')).toBe('old build');
    await expect(fs.access(stage)).rejects.toThrow();
    expect(execute.mock.calls.some(([, args]) => args.includes('refs/tags/v0.1.10:refs/tags/v0.1.10'))).toBe(true);
  });
});
