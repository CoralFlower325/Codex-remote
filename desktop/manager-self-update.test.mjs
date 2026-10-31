import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupApplication, createManagerSelfUpdate, managerUpdateSupport } from './manager-self-update.mjs';
import { releaseFixture } from './test-fixtures/manager-release.mjs';

const folders = [];
afterEach(async () => { for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }); });
async function fixture({ current = '0.2.1', blocked = '', backupError = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-self-update-')); folders.push(root);
  const installer = path.join(root, 'manager.exe'), bytes = Buffer.from('synthetic installer');
  const metadata = Buffer.from('version: 0.2.2');
  await fs.writeFile(installer, bytes);
  const release = releaseFixture();
  for (const [index, content] of [bytes, metadata].entries()) {
    release.assets[index].size = content.length;
    release.assets[index].digest = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  }
  const updater = new EventEmitter();
  updater.setFeedURL = vi.fn();
  const cancellation = { cancelled: false, cancel() { this.cancelled = true; } };
  updater.checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '0.2.2' }, cancellationToken: cancellation }));
  updater.downloadUpdate = vi.fn(async () => {
    updater.emit('download-progress', { transferred: 7, total: bytes.length, bytesPerSecond: 7 });
    updater.emit('update-downloaded', { downloadedFile: installer });
    return [installer];
  });
  updater.quitAndInstall = vi.fn();
  const app = { isPackaged: true, getVersion: () => current, getPath: () => root };
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) };
  const allowed = vi.fn(), backup = vi.fn(async () => {
    if (backupError) throw backupError;
    return path.join(root, 'backup');
  });
  let busy = false;
  const exclusive = async (_label, action) => {
    if (busy) throw new Error('busy');
    busy = true;
    try { return await action(); } finally { busy = false; }
  };
  const fetcher = vi.fn(async url => String(url).endsWith('.yml') ? new Response(metadata) : Response.json([release]));
  const self = createManagerSelfUpdate({ app, getUpdater: () => updater, fetcher, dialog, getWindow: () => null,
    publish: () => {}, exclusive, allowInstallQuit: allowed, platform: 'win32', arch: 'x64',
    support: async () => blocked, backup });
  await self.initialize();
  return { self, app, updater, dialog, allowed, backup, root, installer, fetcher, release, metadata, cancellation };
}

describe('manager self-update', () => {
  it('uses manager version independently and requires explicit download/install', async () => {
    const { self, updater, allowed, root, backup } = await fixture();
    await self.check();
    expect(self.state.status).toBe('available');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await self.download();
    expect(self.state.status).toBe('downloaded');
    expect(self.state.percent).toBe(100);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await self.install();
    expect(backup).toHaveBeenCalledOnce();
    expect(allowed).toHaveBeenCalledWith(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(JSON.parse(await fs.readFile(path.join(root, 'manager-self-update.json'), 'utf8')).phase).toBe('installing');
  });
  it('does not download/restart the current version', async () => {
    const { self, updater } = await fixture({ current: '0.2.2' });
    await self.check();
    expect(self.state.status).toBe('current');
    await expect(self.download()).rejects.toThrow('请先检查');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('cancelling confirmation leaves the program and backup untouched', async () => {
    const { self, dialog, updater, backup } = await fixture();
    await self.check(); await self.download();
    dialog.showMessageBox.mockResolvedValue({ response: 0 });
    await self.install();
    expect(self.state.status).toBe('downloaded');
    expect(backup).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('rejects a changed installer before backup or quit', async () => {
    const { self, installer, backup, updater } = await fixture();
    await self.check(); await self.download();
    await fs.appendFile(installer, 'changed');
    await self.install();
    expect(self.state.status).toBe('error');
    expect(backup).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('rejects mismatching downloaded bytes and metadata', async () => {
    for (const target of ['installer', 'metadata']) {
      const { self, installer, fetcher, release, updater } = await fixture();
      await self.check();
      if (target === 'installer') await fs.writeFile(installer, 'wrong installer');
      else fetcher.mockImplementation(async url => String(url).endsWith('.yml') ? new Response('wrong metadata') : Response.json([release]));
      await self.download();
      expect(self.state.status).toBe('error');
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    }
  });
  it('leaves the app running after backup failure', async () => {
    const { self, updater, allowed } = await fixture({ backupError: new Error('disk full') });
    await self.check(); await self.download(); await self.install();
    expect(self.state.status).toBe('error');
    expect(allowed).not.toHaveBeenCalledWith(true);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('blocks unsigned/source installations without touching the updater', async () => {
    const { self, updater } = await fixture({ blocked: '签名未就绪' });
    await self.check();
    await expect(self.download()).rejects.toThrow('签名未就绪');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(await managerUpdateSupport({ isPackaged: false })).toContain('开发模式');
  });
  it('allows download cancellation without reporting an install', async () => {
    const { self, updater, cancellation } = await fixture();
    await self.check();
    updater.downloadUpdate.mockImplementation(async () => {
      self.cancel();
      throw new Error('cancelled');
    });
    await self.download();
    expect(cancellation.cancelled).toBe(true);
    expect(self.state.status).toBe('available');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('confirms completion from actual app version after restart', async () => {
    const { self, root } = await fixture({ current: '0.2.2' });
    await fs.writeFile(path.join(root, 'manager-self-update.json'), JSON.stringify({ phase: 'installing', toVersion: '0.2.2', backup: 'kept' }));
    await self.initialize();
    expect(self.state.status).toBe('completed');
    expect(JSON.parse(await fs.readFile(path.join(root, 'manager-self-update.json'), 'utf8')).phase).toBe('completed');
  });
  it('reports an unfinished install and keeps the receipt/backup', async () => {
    const { self, root } = await fixture();
    await fs.writeFile(path.join(root, 'manager-self-update.json'), JSON.stringify({ phase: 'installing', toVersion: '0.2.2', backup: 'kept' }));
    await self.initialize();
    expect(self.state.status).toBe('error');
    expect(self.state.backup).toBe('kept');
    expect(JSON.parse(await fs.readFile(path.join(root, 'manager-self-update.json'), 'utf8')).phase).toBe('unconfirmed');
  });
  it('does not overwrite a damaged update receipt', async () => {
    const { self, root, updater } = await fixture();
    await fs.writeFile(path.join(root, 'manager-self-update.json'), '{broken');
    await self.initialize(); await self.check(); await self.download();
    await expect(self.install()).rejects.toThrow('记录损坏');
    expect(await fs.readFile(path.join(root, 'manager-self-update.json'), 'utf8')).toBe('{broken');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('rejects structurally invalid receipts and preserves them', async () => {
    const { self, root } = await fixture();
    await fs.writeFile(path.join(root, 'manager-self-update.json'), '{}');
    await self.initialize(); await self.check(); await self.download();
    await expect(self.install()).rejects.toThrow('记录损坏');
    expect(await fs.readFile(path.join(root, 'manager-self-update.json'), 'utf8')).toBe('{}');
  });
  it('rechecks release digests before downloading', async () => {
    const { self, release, updater } = await fixture();
    await self.check();
    release.assets[0].digest = 'sha256:' + 'b'.repeat(64);
    await self.download();
    expect(self.state.error).toContain('发布信息已变化');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
  it('does not report success when cancellation races with download completion', async () => {
    const { self, updater, installer } = await fixture();
    await self.check();
    updater.downloadUpdate.mockImplementation(async () => { self.cancel(); return [installer]; });
    await self.download();
    expect(self.state.status).toBe('available');
    expect(self.state.percent).toBeNull();
  });
  it('cancels a stalled release recheck through its abort signal', async () => {
    const { self, fetcher, updater } = await fixture();
    await self.check();
    let started;
    const pending = new Promise(resolve => { started = resolve; });
    fetcher.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    }));
    const operation = self.download();
    await pending; self.cancel(); await operation;
    expect(self.state.status).toBe('available');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
  it('rejects an installer changed while backing up', async () => {
    const { self, backup, installer, updater } = await fixture();
    await self.check(); await self.download();
    backup.mockImplementation(async () => { await fs.appendFile(installer, 'changed'); return 'backup'; });
    await self.install();
    expect(self.state.error).toContain('备份期间');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('clears install exit permission on handoff failure', async () => {
    const { self, updater, allowed } = await fixture();
    await self.check(); await self.download();
    updater.quitAndInstall.mockImplementation(() => updater.emit('error', new Error('handoff denied')));
    await self.install();
    expect(self.state.status).toBe('error');
    expect(self.state.error).toContain('handoff denied');
    expect(allowed).toHaveBeenLastCalledWith(false);
    expect(self.state.backup).toBeTruthy();
  });
  it('blocks concurrent operations while installation confirmation is open', async () => {
    const { self, dialog, updater } = await fixture();
    await self.check(); await self.download();
    let confirm;
    dialog.showMessageBox.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const installing = self.install();
    await expect(self.check()).rejects.toThrow('busy');
    confirm({ response: 0 }); await installing;
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('makes a verified application/settings backup without changing originals', async () => {
    const { root } = await fixture();
    const source = path.join(root, 'installed');
    await fs.mkdir(path.join(source, 'resources'), { recursive: true });
    const executable = path.join(source, 'Codex Remote Manager.exe');
    await fs.writeFile(executable, 'synthetic executable');
    await fs.writeFile(path.join(source, 'resources/app.asar'), 'synthetic application');
    await fs.writeFile(path.join(root, 'settings.json'), '{"root":"synthetic"}');
    const saved = await backupApplication({ getPath: kind => kind === 'exe' ? executable : root },
      '0.2.0', '0.2.1', path.join(root, 'backups'), 'win32');
    const manifest = JSON.parse(await fs.readFile(path.join(saved, 'backup.json'), 'utf8'));
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.targetVersion).toBe('0.2.1');
    expect(manifest.entries).toHaveLength(2);
    expect(await fs.readFile(path.join(saved, 'settings.json'), 'utf8')).toBe('{"root":"synthetic"}');
    expect(await fs.readFile(path.join(saved, 'application/resources/app.asar'), 'utf8')).toBe('synthetic application');
    await expect(backupApplication({ getPath: kind => kind === 'exe' ? executable : root },
      '0.2.0', '0.2.1', path.join(source, 'backups'), 'win32')).rejects.toThrow('不能位于');
    expect(await fs.readFile(executable, 'utf8')).toBe('synthetic executable');
  });
});
