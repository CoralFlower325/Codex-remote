import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pendingUpdate, recoverPendingUpdate, acquireUpdateLock, recordUpdate, processStartIdentity } from './update-transaction.mjs';

const temporary = [];
async function write(root, name, value) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), value);
}
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-crash-')));
  temporary.push(directory);
  const root = path.join(directory, 'root'); const stage = path.join(directory, 'stage');
  for (const [base, value] of [[root, 'old'], [stage, 'new']]) {
    for (const name of ['package.json', 'dist/client/index.html', 'dist-server/server/index.js', 'node_modules/working.txt']) {
      await write(base, name, value);
    }
  }
  await write(root, 'data/auth.json', 'private fixture');
  return { root, stage };
}
async function interrupt(root, stage, checkpoint, running = true) {
  const child = fork(fileURLToPath(new URL('./fixtures/update-crash.mjs', import.meta.url)),
    [root, stage, checkpoint, String(running)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Checkpoint timed out: ${output}`)); }, 15_000);
    child.once('message', () => { clearTimeout(timer); child.kill('SIGKILL'); });
    child.once('exit', () => { clearTimeout(timer); output ? reject(new Error(output)) : resolve(); });
  });
}
afterEach(async () => {
  for (const name of temporary.splice(0)) await fs.rm(name, { recursive: true, force: true });
});
describe('durable interrupted update recovery', () => {
  it.each(['stop', 'dependencies', 'file-write', 'source', 'verify'])('recovers after a killed updater at %s', async (checkpoint) => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, checkpoint);
    expect(await pendingUpdate(root)).not.toBeNull();
    const calls = [];
    await recoverPendingUpdate(root, { stop: async () => calls.push('stop'),
      start: async () => calls.push('start'), verify: async () => calls.push('verify') });
    expect(await pendingUpdate(root)).toBeNull();
    expect(calls.slice(-2)).toEqual(['start', 'verify']);
    for (const name of ['package.json', 'dist/client/index.html', 'dist-server/server/index.js', 'node_modules/working.txt']) {
      expect(await fs.readFile(path.join(root, name), 'utf8')).toBe('old');
    }
    expect(await fs.readFile(path.join(root, 'data/auth.json'), 'utf8')).toBe('private fixture');
    expect((await fs.readdir(root)).some((name) => name.includes('.codex-remote-'))).toBe(false);
  }, 25_000);
  it('can recover again after the recovery process itself is killed', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'verify');
    await interrupt(root, stage, 'recovery');
    expect((await pendingUpdate(root)).phase).toBe('recovering');
    await recoverPendingUpdate(root, { stop: vi.fn(), start: vi.fn(), verify: vi.fn() });
    expect(await fs.readFile(path.join(root, 'node_modules/working.txt'), 'utf8')).toBe('old');
    await expect(fs.access(path.join(root, 'node_modules/partial'))).rejects.toThrow();
    expect(await recoverPendingUpdate(root, {})).toBeNull();
  }, 40_000);
  it('keeps a stopped installation stopped during recovery', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'source', false);
    const start = vi.fn();
    await recoverPendingUpdate(root, { stop: vi.fn(), start, verify: vi.fn() });
    expect(start).not.toHaveBeenCalled();
  }, 25_000);
  it('preserves later source edits and the journal instead of overwriting them', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'source');
    await write(root, 'package.json', 'manual edit after interruption');
    const stop = vi.fn();
    await expect(recoverPendingUpdate(root, { stop })).rejects.toThrow('又被修改');
    expect(stop).not.toHaveBeenCalled();
    expect(await pendingUpdate(root)).not.toBeNull();
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe('manual edit after interruption');
  });
  it('refuses a live updater lock and refuses incomplete recovery evidence', async () => {
    const { root, stage } = await fixture();
    const release = await acquireUpdateLock(root);
    await expect(acquireUpdateLock(root)).rejects.toThrow('另一个');
    await release();
    await interrupt(root, stage, 'source');
    const pending = await pendingUpdate(root);
    await write(pending.backup, 'source/package.json', 'damaged backup');
    const stop = vi.fn();
    await expect(recoverPendingUpdate(root, { stop })).rejects.toThrow('备份不完整');
    expect(stop).not.toHaveBeenCalled();
    expect(await pendingUpdate(root)).not.toBeNull();
  });
  it('finalizes an already committed transaction without stopping or restoring service', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'verify');
    const pending = await pendingUpdate(root);
    await recordUpdate(root, pending, 'committed');
    const stop = vi.fn(); const start = vi.fn();
    expect((await recoverPendingUpdate(root, { stop, start })).terminal).toBe('committed');
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe('new');
    expect(await pendingUpdate(root)).toBeNull();
  });
  it('uses the same installation identity through an alternate directory path', async () => {
    const { root, stage } = await fixture();
    const alias = path.join(path.dirname(root), 'alias');
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await interrupt(alias, stage, 'source', false);
    expect((await pendingUpdate(alias)).root).toBe(root);
    await recoverPendingUpdate(alias, { stop: vi.fn(), start: vi.fn(), verify: vi.fn() });
    expect(await pendingUpdate(root)).toBeNull();
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe('old');
  });

  it('recovers a damaged primary journal from its durable checksummed mirror', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'source');
    const journal = path.join(root, 'output', 'manager-update', 'active.json');
    await fs.writeFile(journal, '{"truncated":');
    expect((await pendingUpdate(root)).phase).toBe('installing');
    await recoverPendingUpdate(root, { stop: vi.fn(), start: vi.fn(), verify: vi.fn() });
    expect(await pendingUpdate(root)).toBeNull();
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe('old');
  });

  it('detects valid JSON corruption by checksum and can recover when one journal is missing', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'source', false);
    const directory = path.join(root, 'output', 'manager-update');
    const primary = path.join(directory, 'active.json');
    const data = JSON.parse(await fs.readFile(primary, 'utf8'));
    data.wasRunning = true;
    await fs.writeFile(primary, JSON.stringify(data));
    expect((await pendingUpdate(root)).wasRunning).toBe(false);
    await fs.rm(primary);
    expect((await pendingUpdate(root)).wasRunning).toBe(false);
    await recoverPendingUpdate(root, { stop: vi.fn(), start: vi.fn(), verify: vi.fn() });
  });

  it('selects the newer mirror if a crash interrupts the second journal write', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'source', false);
    const transaction = await pendingUpdate(root);
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(root, 'output', 'manager-update', 'active.json')) throw new Error('Interrupted primary write');
      return rename(from, to);
    });
    try { await expect(recordUpdate(root, transaction, 'verifying')).rejects.toThrow('Interrupted'); }
    finally { spy.mockRestore(); }
    const recovered = await pendingUpdate(root);
    expect(recovered.phase).toBe('verifying');
    expect(recovered.journalSequence).toBe(transaction.journalSequence + 1);
  });

  it('preserves both corrupt journals and all recovery evidence without touching service', async () => {
    const { root, stage } = await fixture();
    await interrupt(root, stage, 'source');
    const directory = path.join(root, 'output', 'manager-update');
    await fs.writeFile(path.join(directory, 'active.json'), 'damaged primary');
    await fs.writeFile(path.join(directory, 'active.mirror.json'), 'damaged mirror');
    const stop = vi.fn();
    await expect(recoverPendingUpdate(root, { stop })).rejects.toThrow('preserved');
    expect(stop).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, 'active.json'), 'utf8')).toBe('damaged primary');
    expect(await fs.readFile(path.join(directory, 'active.mirror.json'), 'utf8')).toBe('damaged mirror');
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe('new');
  });

  it('uses operating-system process start identity to detect PID reuse without stealing a live lock', async () => {
    const { root } = await fixture();
    const identity = await processStartIdentity(process.pid);
    expect(identity).toBeTypeOf('string');
    const release = await acquireUpdateLock(root);
    await expect(acquireUpdateLock(root)).rejects.toThrow();
    await release();
    const file = path.join(root, 'output', 'manager-update', 'lock.json');
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, processStart: 'old-process-start', token: 'old' }));
    const releaseReused = await acquireUpdateLock(root);
    const replacement = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(replacement.processStart).toBe(identity);
    await fs.writeFile(file, JSON.stringify({ ...replacement, token: 'different-owner' }));
    await releaseReused();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).token).toBe('different-owner');
  }, 15_000);

  it('preserves a live lock if its process identity cannot be checked', async () => {
    const { root } = await fixture();
    const release = await acquireUpdateLock(root);
    const identify = vi.fn().mockResolvedValueOnce('current').mockRejectedValueOnce(new Error('Access denied'));
    await expect(acquireUpdateLock(root, identify)).rejects.toThrow('Access denied');
    expect(identify).toHaveBeenCalledTimes(2);
    await expect(acquireUpdateLock(root)).rejects.toThrow();
    await release();
  }, 15_000);
});
