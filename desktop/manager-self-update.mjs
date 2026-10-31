import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { latestManagerRelease } from './manager-release.mjs';
import { compareVersions, versionPattern } from './release.mjs';

const execute = promisify(execFile);
const hashFile = async filename => {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
};

export async function managerUpdateSupport(app, platform = process.platform, arch = process.arch) {
  if (!app.isPackaged) return '开发模式不替换管理器，请使用正式安装包。';
  if (!((platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64'))) {
    return '自更新仅支持 Windows x64 和 Apple Silicon。';
  }
  if (!await fs.stat(path.join(process.resourcesPath, 'app-update.yml')).catch(() => null)) {
    return '此安装包没有自更新配置，请先安装支持自更新的管理器。';
  }
  if (platform === 'darwin') {
    const bundle = path.resolve(path.dirname(app.getPath('exe')), '../..');
    if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/')) return '请先将管理器移入“应用程序”后再更新。';
    try {
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 15_000 });
      const signature = await execute('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { timeout: 15_000 });
      if (!/^TeamIdentifier=[A-Z0-9]{10}$/m.test(signature.stderr)) {
        return '此 Mac 管理器尚未使用开发者证书签名，暂不能自动安装；请通过安装包升级。';
      }
    } catch {
      return '此 Mac 管理器的开发者签名尚未通过校验，请通过安装包升级。';
    }
  }
  return '';
}

export async function backupApplication(app, version, targetVersion, directory, platform) {
  const executable = app.getPath('exe');
  const source = await fs.realpath(platform === 'darwin' ? path.resolve(path.dirname(executable), '../..') : path.dirname(executable));
  if ((platform === 'darwin' && !source.endsWith('.app')) ||
    (platform === 'win32' && path.basename(executable) !== 'Codex Remote Manager.exe')) {
    throw new Error('无法确认当前管理器安装目录，已停止更新。');
  }
  const backup = path.join(directory, crypto.randomUUID());
  await fs.mkdir(backup, { recursive: true });
  const relative = path.relative(source, await fs.realpath(backup));
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('备份目录不能位于管理器程序目录内。');
  }
  const application = path.join(backup, 'application');
  await fs.cp(source, application, { recursive: true, verbatimSymlinks: true });
  const entries = [];
  async function verify(relative = '') {
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await verify(name);
      else if (entry.isSymbolicLink()) {
        const link = await fs.readlink(path.join(source, name));
        if (link !== await fs.readlink(path.join(application, name))) throw new Error('管理器备份链接校验失败。');
        entries.push({ path: name, link });
      } else if (entry.isFile()) {
        const sha256 = await hashFile(path.join(source, name));
        if (sha256 !== await hashFile(path.join(application, name))) throw new Error('管理器备份文件校验失败。');
        entries.push({ path: name, sha256 });
      } else throw new Error('管理器目录包含不支持的文件，已停止更新。');
    }
  }
  await verify();
  const settings = path.join(app.getPath('userData'), 'settings.json');
  if (await fs.stat(settings).catch(() => null)) await fs.copyFile(settings, path.join(backup, 'settings.json'));
  await fs.writeFile(path.join(backup, 'backup.json'),
    JSON.stringify({ version, targetVersion, source, entries }, null, 2), 'utf8');
  return backup;
}

async function writeReceipt(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.next';
  const file = await fs.open(temporary, 'w');
  try { await file.writeFile(JSON.stringify(value), 'utf8'); await file.sync(); }
  finally { await file.close(); }
  await fs.rename(temporary, filename);
}

export function createManagerSelfUpdate({ app, getUpdater, fetcher = fetch, dialog, getWindow, publish,
  exclusive, allowInstallQuit, shell, platform = process.platform, arch = process.arch,
  support = () => managerUpdateSupport(app, platform, arch), backup = backupApplication }) {
  const currentVersion = app.getVersion();
  const receiptFile = path.join(app.getPath('userData'), 'manager-self-update.json');
  const state = { status: 'idle', version: '', notes: '', detail: '', error: '', blocked: '',
    percent: null, transferred: 0, total: 0, bytesPerSecond: 0, backup: '', startedAt: null };
  let release = null, updater = null, cancellation = null, downloadedFile = '', installingTimer = null;
  let cancelRequested = false, metadataAbort = null, receiptDamaged = false;
  const change = value => { Object.assign(state, value); publish(); };
  const fail = error => change({ status: 'error', error: `管理器更新未完成：${error.message}`,
    detail: '管理器和 Remote 保持原状，可以重试。' });
  function engine() {
    if (updater) return updater;
    updater = getUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.logger = null;
    updater.on('download-progress', progress => {
      if (state.status !== 'downloading') return;
      change({ transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond,
        percent: progress.total > 0 ? Math.min(99, Math.floor(progress.transferred / progress.total * 100)) : null });
    });
    updater.on('update-downloaded', info => { downloadedFile = info.downloadedFile; });
    updater.on('error', error => {
      if (state.status === 'installing') {
        clearTimeout(installingTimer);
        allowInstallQuit(false);
        change({ status: 'error', error: `安装交接未完成：${error.message}`,
          detail: '已保留管理器备份，请重新打开管理器后检查实际版本。' });
      }
    });
    return updater;
  }
  async function initialize() {
    state.blocked = await support();
    try {
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      if (!receipt || !['installing', 'completed', 'unconfirmed'].includes(receipt.phase) ||
        !versionPattern.test(receipt.toVersion) || typeof receipt.backup !== 'string') {
        throw new Error('Invalid update receipt.');
      }
      state.backup = typeof receipt.backup === 'string' ? receipt.backup : '';
      if (['installing', 'unconfirmed'].includes(receipt.phase)) {
        const completed = receipt.toVersion === currentVersion;
        change(completed ? { status: 'completed', version: currentVersion,
          detail: `管理器已更新到 ${currentVersion}，Remote 服务保持原有运行状态。` }
          : { status: 'error', error: '上次管理器安装未确认完成。',
            detail: `当前仍为 ${currentVersion}。已保留更新记录和备份，可重新检查更新。` });
        await writeReceipt(receiptFile, { ...receipt, phase: completed ? 'completed' : 'unconfirmed',
          observedVersion: currentVersion, checkedAt: Date.now() });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        receiptDamaged = true;
        change({ status: 'error', error: '无法读取上次管理器更新记录。',
          detail: '记录已保留；请检查本机文件权限后重试。' });
      }
    }
    publish();
  }
  async function check() {
    return exclusive('正在检查管理器版本', async () => {
      if (state.status === 'downloaded' || state.status === 'installing') throw new Error('请先处理已下载的管理器更新。');
      release = null;
      change({ status: 'checking', error: '', notes: '', version: '', percent: null, detail: '正在读取管理器独立发布。' });
      try {
        const found = await latestManagerRelease(currentVersion, platform, arch, fetcher);
        state.blocked = await support();
        release = found;
        change({ status: found?.available ? 'available' : 'current', version: found?.version || currentVersion,
          notes: found?.notes || '', detail: found?.available ? `发现管理器 ${found.version}。`
            : found ? `管理器 ${currentVersion} 已是最新版本。` : `尚无可用的管理器独立更新，当前版本为 ${currentVersion}。` });
      } catch (error) { fail(error); }
    });
  }
  async function download() {
    return exclusive('正在下载管理器更新', async () => {
      if (!release?.available || !['available', 'error'].includes(state.status)) throw new Error('请先检查管理器更新。');
      state.blocked = await support();
      if (state.blocked) throw new Error(state.blocked);
      const selected = release;
      cancelRequested = false;
      metadataAbort = new AbortController();
      change({ status: 'downloading', error: '', percent: 0, transferred: 0, total: selected.asset.size,
        startedAt: Date.now(), detail: '正在下载安装包，Remote 继续运行。' });
      try {
        const latest = await latestManagerRelease(currentVersion, platform, arch, fetcher, metadataAbort.signal);
        if (!latest || latest.tag !== selected.tag || latest.asset.sha256 !== selected.asset.sha256 ||
          latest.metadata.sha256 !== selected.metadata.sha256) throw new Error('发布信息已变化，请重新检查管理器更新。');
        if (cancelRequested) throw new Error('下载已取消。');
        const response = await fetcher(selected.metadata.url, {
          signal: AbortSignal.any([metadataAbort.signal, AbortSignal.timeout(30_000)]), redirect: 'follow'
        });
        if (!response.ok) throw new Error(`读取更新清单失败（HTTP ${response.status}）。`);
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > 256 * 1024 || length > selected.metadata.size) throw new Error('更新清单超出大小限制。');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== selected.metadata.size ||
          crypto.createHash('sha256').update(bytes).digest('hex') !== selected.metadata.sha256) {
          throw new Error('更新清单摘要不匹配。');
        }
        const service = engine();
        service.setFeedURL({ provider: 'generic', url: selected.baseUrl, useMultipleRangeRequest: false });
        const checked = await service.checkForUpdates();
        if (!checked || checked.updateInfo.version !== selected.version ||
          compareVersions(checked.updateInfo.version, currentVersion) <= 0) throw new Error('安装包版本与管理器发布不一致。');
        cancellation = checked.cancellationToken;
        if (cancelRequested) { cancellation?.cancel(); throw new Error('下载已取消。'); }
        downloadedFile = '';
        const files = await service.downloadUpdate(cancellation);
        if (cancelRequested) throw new Error('下载已取消。');
        downloadedFile ||= files?.[0] || '';
        if (!downloadedFile) throw new Error('未找到已下载的管理器安装包。');
        change({ detail: '下载完成，正在校验安装包。', percent: 99 });
        const stat = await fs.stat(downloadedFile);
        if (stat.size !== selected.asset.size || await hashFile(downloadedFile) !== selected.asset.sha256) {
          downloadedFile = '';
          throw new Error('安装包摘要不匹配，已阻止安装。');
        }
        change({ status: 'downloaded', percent: 100, transferred: stat.size, total: stat.size,
          detail: '安装包已校验，确认后退出管理器并安装。Remote 继续运行。' });
      } catch (error) {
        if (cancelRequested || cancellation?.cancelled) change({ status: 'available', percent: null, detail: '下载已取消，管理器和 Remote 保持运行。' });
        else fail(error);
      } finally { cancellation = null; metadataAbort = null; }
    });
  }
  async function install() {
    if (receiptDamaged) throw new Error('更新记录损坏，已停止覆盖。请先检查管理器更新记录和备份。');
    if (state.status !== 'downloaded' || !downloadedFile || !release) throw new Error('请先下载并校验管理器安装包。');
    return exclusive('正在准备安装管理器', async () => {
      const { response } = await dialog.showMessageBox(getWindow(), {
        type: 'question', title: '更新管理器', message: `安装管理器 ${release.version} 并重新打开？`,
        detail: '将备份当前管理器和设置，退出管理器后完成安装。Remote、Codex Desktop 和隧道保持原有状态。',
        buttons: ['取消', '安装并重新打开'], defaultId: 0, cancelId: 0
      });
      if (response !== 1) return;
      if (state.status !== 'downloaded') throw new Error('管理器更新状态已变化，请重试。');
      state.blocked = await support();
      if (state.blocked) throw new Error(state.blocked);
      try {
        if (await hashFile(downloadedFile) !== release.asset.sha256) throw new Error('安装包已发生变化，已阻止安装。');
        change({ detail: '正在备份管理器程序与设置。' });
        const saved = await backup(app, currentVersion, release.version, path.join(app.getPath('userData'), 'manager-update-backups'), platform);
        if (await hashFile(downloadedFile) !== release.asset.sha256) throw new Error('备份期间安装包已变化，已阻止安装。');
        const receipt = { phase: 'installing', fromVersion: currentVersion, toVersion: release.version,
          tag: release.tag, backup: saved, installer: downloadedFile, sha256: release.asset.sha256, startedAt: Date.now() };
        await writeReceipt(receiptFile, receipt);
        change({ status: 'installing', backup: saved, detail: '正在交接安装程序，管理器将重新打开。' });
        allowInstallQuit(true);
        installingTimer = setTimeout(() => {
          if (state.status !== 'installing') return;
          allowInstallQuit(false);
          change({ status: 'error', error: '安装程序尚未完成交接。',
            detail: '已保留安装包、更新记录和备份。当前管理器可继续使用，请重试安装。' });
        }, 90_000);
        installingTimer.unref?.();
        engine().quitAndInstall(true, true);
        if (state.status !== 'installing') clearTimeout(installingTimer);
      } catch (error) { clearTimeout(installingTimer); allowInstallQuit(false); fail(error); }
    });
  }
  function cancel() {
    if (state.status !== 'downloading') return;
    cancelRequested = true; metadataAbort?.abort(); cancellation?.cancel();
  }
  async function openInstaller() {
    if (!release?.available) throw new Error('请先检查管理器更新。');
    await shell.openExternal(release.asset.url);
  }
  return { state, initialize, check, download, install, cancel, openInstaller };
}
