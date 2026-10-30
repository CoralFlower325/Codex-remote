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
  vi.unstubAllEnvs();
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
  it('retains conflicting local documentation and rules, but still blocks source conflicts', async () => {
    const root = await directory(); const stage = await directory();
    const docs = ['AGENTS.md', 'README.md', 'README.zh-CN.md', 'docs/README.md',
      'docs/guide.md', 'docs/guide.zh-CN.md', 'docs/maintainer-handoff.md'];
    for (const file of docs) {
      await write(root, file, 'private notes');
      await write(stage, file, 'new official docs');
    }
    await write(stage, 'docs/deleted-locally.md', 'new official docs');
    const files = [...docs, 'docs/deleted-locally.md'];
    expect(await planFiles(root, stage, files, async () => Buffer.from('old official docs')))
      .toEqual(files.map((relative) => ({ relative, remove: false, preserve: true })));
    await write(root, 'src/a.ts', 'custom code'); await write(stage, 'src/a.ts', 'new code');
    await expect(planFiles(root, stage, [...files, 'src/a.ts'], async () => Buffer.from('old')))
      .rejects.toThrow('src/a.ts');
    await write(root, 'docs/run.mjs', 'custom executable'); await write(stage, 'docs/run.mjs', 'new executable');
    await expect(planFiles(root, stage, ['docs/run.mjs'], async () => Buffer.from('old')))
      .rejects.toThrow('docs/run.mjs');
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
  const root = await directory(); const stage = await directory(); const cache = await directory();
  for (const base of [root, stage]) {
    await write(base, 'dist/client/index.html', base === root ? 'old' : 'new');
    await write(base, 'dist-server/server/index.js', base === root ? 'old' : 'new');
  }
  await write(root, 'data/auth.json', 'private');
  return { info: { root, version: '0.1.9', publicUrl: '' }, stage, plan: [],
    tools: { node: 'node', npmPath: 'npm-cli.js', cache, env: { npm_config_cache: cache } }, commit: 'abc',
    release: { version: '0.1.10' }, execute: vi.fn().mockResolvedValue('') };
}
describe('installation transaction', () => {
  it('installs offline from the prepared cache, streams output and completes after verification', async () => {
    const item = await prepared();
    const updates = [];
    item.execute.mockImplementationOnce(async (_file, args, options) => {
      expect(args).toContain('--offline');
      expect(options.env.npm_config_offline).toBe('true');
      options.onLine('dependencies installed'); return '';
    });
    await installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify: vi.fn(),
      isRunning: async () => false, progress: (title, state) => updates.push({ title, ...state }) });
    expect(item.execute).toHaveBeenCalledTimes(1);
    expect(updates.some((state) => state.logs.some((line) => line.message.includes('dependencies installed')))).toBe(true);
    expect(updates.at(-1)).toMatchObject({ percent: 100, status: 'completed' });
    expect(updates.map((state) => state.percent)).toEqual([...updates.map((state) => state.percent)].sort((a, b) => a - b));
  });
  it('restores the original dependencies without network after failed offline installation', async () => {
    const item = await prepared();
    await write(item.info.root, 'node_modules/old-dependency/sentinel', 'working old dependency');
    item.execute.mockImplementationOnce(async () => {
      await write(item.info.root, 'node_modules/partial-new-package/index.js', 'partial install');
      throw new Error('ENOTCACHED offline dependency missing');
    });
    const verify = vi.fn();
    await expect(installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify,
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('已恢复旧版');
    expect(item.execute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(item.info.root, 'node_modules/old-dependency/sentinel'), 'utf8')).toBe('working old dependency');
    await expect(fs.access(path.join(item.info.root, 'node_modules/partial-new-package'))).rejects.toThrow();
  });
  it('reports failed recovery honestly without claiming completion', async () => {
    const item = await prepared(); const updates = [];
    item.execute.mockRejectedValue(new Error('dependency install failed'));
    await expect(installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: (_title, state) => updates.push(state) })).rejects.toThrow('自动恢复也未能完成');
    expect(item.execute).toHaveBeenCalledTimes(2);
    expect(updates.at(-1)).toMatchObject({ status: 'recovery-failed', percent: 40 });
  });
  it('attempts recovery when stop partially changes service state before rejecting', async () => {
    const item = await prepared(); const start = vi.fn(); const verify = vi.fn();
    await expect(installUpdate(item, { stop: vi.fn().mockRejectedValue(new Error('stop did not finish')),
      start, verify, isRunning: async () => true, progress: () => {} })).rejects.toThrow('尚未替换');
    expect(start).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
    expect(item.execute).not.toHaveBeenCalled();
  });
  it('preserves edited and deleted documentation, backs up both versions, and records retention', async () => {
    const item = await prepared();
    await write(item.info.root, 'AGENTS.md', 'private rules');
    await write(item.stage, 'AGENTS.md', 'new official rules');
    await write(item.stage, 'docs/deleted.md', 'new official docs');
    item.plan = [
      { relative: 'AGENTS.md', before: crypto.createHash('sha256').update('private rules').digest('hex'), remove: false, preserve: true },
      { relative: 'docs/deleted.md', before: null, remove: false, preserve: true }
    ];
    const result = await installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify: vi.fn(),
      isRunning: async () => false, progress: () => {} });
    expect(result.preservedFiles).toEqual(['AGENTS.md', 'docs/deleted.md']);
    expect(await fs.readFile(path.join(item.info.root, 'AGENTS.md'), 'utf8')).toBe('private rules');
    await expect(fs.access(path.join(item.info.root, 'docs/deleted.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(result.backup, 'source/AGENTS.md'), 'utf8')).toBe('private rules');
    expect(await fs.readFile(path.join(result.backup, 'incoming/AGENTS.md'), 'utf8')).toBe('new official rules');
    expect(await fs.readFile(path.join(result.backup, 'incoming/docs/deleted.md'), 'utf8')).toBe('new official docs');
    expect(JSON.parse(await fs.readFile(path.join(result.backup, 'receipt.json'), 'utf8')).plan[0].preserve).toBe(true);
  });
  it('keeps local rules intact when an install with retained documentation rolls back', async () => {
    const item = await prepared();
    await write(item.info.root, 'AGENTS.md', 'private rules');
    await write(item.stage, 'AGENTS.md', 'official rules');
    item.plan = [{ relative: 'AGENTS.md', before: crypto.createHash('sha256').update('private rules').digest('hex'),
      remove: false, preserve: true }];
    item.execute.mockRejectedValueOnce(new Error('failed install')).mockResolvedValueOnce('');
    await expect(installUpdate(item, { stop: vi.fn(), start: vi.fn(), verify: vi.fn(),
      isRunning: async () => false, progress: () => {} })).rejects.toThrow('已恢复旧版');
    expect(await fs.readFile(path.join(item.info.root, 'AGENTS.md'), 'utf8')).toBe('private rules');
  });
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
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('已恢复旧版');
    expect(await fs.readFile(path.join(item.info.root, 'dist/client/index.html'), 'utf8')).toBe('old');
    expect(item.execute).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    for (const [, args, options] of item.execute.mock.calls) {
      expect(args.slice(0, 3)).toEqual(['npm-cli.js', '--cache', item.tools.cache]);
      expect(options.env.npm_config_cache).toBe(item.tools.cache);
      expect(options.cwd).toBe(item.info.root);
    }
    await expect(fs.access(item.tools.cache)).rejects.toThrow();
  });
  it('blocks changed live files before stopping the service', async () => {
    const item = await prepared(); const stop = vi.fn();
    await write(item.info.root, 'source.txt', 'new local edit');
    item.plan = [{ relative: 'source.txt', before: 'previous hash', remove: false }];
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('尚未替换');
    expect(stop).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(item.info.root, 'source.txt'), 'utf8')).toBe('new local edit');
  });
  it('blocks a preserved build input changed during preparation', async () => {
    const item = await prepared(); const stop = vi.fn();
    await write(item.info.root, 'src/custom.ts', 'edited after build');
    item.inputs = [{ relative: 'src/custom.ts', before: 'previous hash' }];
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('尚未替换');
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
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('已恢复旧版');
    expect(await fs.readFile(path.join(item.info.root, 'source.txt'), 'utf8')).toBe('old source');
    await expect(fs.access(path.join(item.info.root, 'addition.txt'))).rejects.toThrow();
  });
  it('refuses linked backup directories before changing the live installation', async () => {
    const item = await prepared(); const outside = await directory(); const stop = vi.fn();
    await fs.symlink(outside, path.join(item.info.root, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installUpdate(item, { stop, start: vi.fn(), verify: vi.fn(),
      isRunning: async () => true, progress: () => {} })).rejects.toThrow('尚未替换');
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
    const userCache = await directory();
    await write(userCache, 'preserved.txt', 'user cache');
    vi.stubEnv('NPM_CONFIG_CACHE', userCache);
    vi.stubEnv('npm_config_cache', userCache);
    let stage; let cache; let installs = 0;
    const updates = [];
    const execute = vi.fn(async (file, args, options) => {
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
      if (args[0] === 'npm-cli.js') {
        cache = options.env.npm_config_cache;
        expect(cache).not.toBe(userCache);
        expect(options.env.NPM_CONFIG_CACHE).toBeUndefined();
        expect(args.slice(1, 3)).toEqual(['--cache', cache]);
        await write(cache, 'writable.txt', 'isolated cache');
        if (args.includes('ci') && ++installs === 1) throw new Error('ECONNRESET socket hang up');
      }
      if (args.includes('typecheck')) throw new Error('validation failure');
      return '';
    });
    await expect(prepareUpdate(root, { tag: 'v0.1.10', version: '0.1.10' },
      (_title, state) => updates.push(state), execute)).rejects.toThrow('尚未安装');
    expect(installs).toBe(2);
    expect(updates.some((state) => state.detail.includes('最后一次重试'))).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: 'failed', percent: 43 });
    expect(await fs.readFile(path.join(root, 'source.txt'), 'utf8')).toBe('old source');
    expect(await fs.readFile(path.join(root, 'dist-server/server/index.js'), 'utf8')).toBe('old build');
    await expect(fs.access(stage)).rejects.toThrow();
    await expect(fs.access(cache)).rejects.toThrow();
    expect(await fs.readFile(path.join(userCache, 'preserved.txt'), 'utf8')).toBe('user cache');
    expect(await fs.readdir(userCache)).toEqual(['preserved.txt']);
    expect(execute.mock.calls.some(([, args]) => args.includes('refs/tags/v0.1.10:refs/tags/v0.1.10'))).toBe(true);
  });
});
