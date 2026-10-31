import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, dialog, shell, net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installation } from './controller.mjs';
import { readDiagnosticLogs } from './diagnostics.mjs';
import { createManagerSession } from './manager-session.mjs';
import { trayAppearance } from './tray-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fetchRelease = (url, options) => net.fetch(url, { ...options, credentials: 'omit' });
const labels = {
  healthy: '运行正常', degraded: '需要检查', stopped: '已关闭',
  conflict: '安装目录冲突', unowned: '端口被其他服务使用'
};
let win; let tray; let timer; let quitting = false;
let dockTimer; let lastDockChange = 0;
let showingDock = null;
let suppressActivationUntil = 0;
let trayImageKey = '';
const session = createManagerSession({
  app, dialog, shell, fetchRelease, getWindow: () => win, publish, here
});
const {
  state, settings, snapshot, saveSettings, refresh, showError, exclusive,
  action, openRemote, diagnose, repair, security, checkUpdate, update,
  recoverInstallation, chooseDirectory, selectDirectory, detectDirectory, restoreDirectory
} = session;
function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('manager:state', snapshot());
  updateTray();
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(dockTimer);
  if (process.platform === 'darwin' && !app.dock.isVisible() && !showingDock) {
    showingDock = app.dock.show().then(() => { lastDockChange = Date.now(); })
      .catch(showError).finally(() => { showingDock = null; });
  }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  void refresh();
}
function hideWindow() {
  if (!tray) return;
  if (process.platform === 'darwin') suppressActivationUntil = Date.now() + 2500;
  win.hide();
  if (process.platform === 'darwin') {
    clearTimeout(dockTimer);
    // Wait for a pending show before hiding; Cocoa can otherwise restore the
    // icon after hide. Electron also needs a quiet second between transitions.
    void Promise.resolve(showingDock).then(() => {
      if (win.isDestroyed() || win.isVisible()) return;
      dockTimer = setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) {
          suppressActivationUntil = Date.now() + 1200;
          lastDockChange = Date.now();
          app.dock.hide();
        }
      }, Math.max(0, 1100 - (Date.now() - lastDockChange)));
    });
  }
}
function updateTray() {
  if (!tray) return;
  const { healthError } = snapshot();
  const appearance = trayAppearance(state.status, healthError, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
  const imageKey = process.platform === 'darwin' ? appearance.template : appearance.windows;
  if (imageKey !== trayImageKey) {
    let icon = nativeImage.createFromPath(path.join(here, 'assets', imageKey));
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    else icon = icon.resize({ width: 20, height: 20 });
    tray.setImage(icon);
    trayImageKey = imageKey;
  }
  const text = healthError ? '状态检测失败' : labels[state.status?.state] || '未选择安装目录';
  tray.setToolTip(`Codex Remote · ${state.busy || text}`);
  const ready = Boolean(settings.root) && !state.busy && !state.recoveryRequired && !healthError &&
    !['conflict', 'unowned'].includes(state.status?.state);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Codex Remote · ${state.busy || text}`, enabled: false },
    { type: 'separator' },
    { label: '显示管理器', click: showWindow },
    { label: '打开 Remote', enabled: Boolean(state.status?.backend.reachable),
      click: () => void openRemote().catch(showError) },
    { type: 'separator' },
    { label: '开启 Remote', enabled: ready && state.status?.state === 'stopped',
      click: () => void action('Start').catch(showError) },
    { label: '关闭 Remote', enabled: ready && Boolean(state.status?.service.running),
      click: () => void action('Stop').catch(showError) },
    { label: '检查更新', enabled: ready, click: () => { showWindow(); void checkUpdate().catch(showError); } },
    { type: 'separator' },
    { label: '退出管理器', enabled: !state.busy, click: () => app.quit() }
  ]));
}
function trusted(event) {
  return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url === fileURLToPathUrl();
}
function fileURLToPathUrl() { return new URL('./dist/index.html', import.meta.url).href; }
function handle(name, fn) {
  ipcMain.handle(`manager:${name}`, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted IPC sender.');
    try { const result = await fn(...args); return { ok: true, value: result ?? snapshot() }; }
    catch (error) {
      if (state.error !== error.message) showError(error);
      return { ok: false, error: error.message, value: snapshot() };
    }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', () => {
    // Ignore activation caused by our Dock transition, then allow the normal
    // Finder/Spotlight/Dock entry points to restore a hidden window.
    if (Date.now() >= suppressActivationUntil) showWindow();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    if (state.busy) { e.preventDefault(); showWindow(); return; }
    quitting = true; clearInterval(timer); clearTimeout(dockTimer);
  });
  app.whenReady().then(async () => {
  app.setAppUserModelId('io.github.coralflower325.codex-remote-manager');
  try { Object.assign(settings, JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'))); } catch {}
  settings.launchAtLogin = app.isPackaged && app.getLoginItemSettings().openAtLogin;
  if (!app.isPackaged) {
    const rootArg = process.argv.find((arg) => arg.startsWith('--installation='));
    if (rootArg) settings.root = rootArg.slice('--installation='.length);
  }
  const image = nativeImage.createFromPath(path.join(here, 'assets', 'app.png'));
  win = new BrowserWindow({
    width: 480, height: 690, minWidth: 400, minHeight: 550, show: false,
    title: 'Codex Remote', backgroundColor: '#ffffff', icon: image,
    webPreferences: { preload: path.join(here, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  try {
    let trayImage = nativeImage.createFromPath(path.join(here, 'assets',
      process.platform === 'darwin' ? 'trayStoppedTemplate.png' : 'trayStopped.png'));
    if (process.platform === 'darwin') trayImage.setTemplateImage(true);
    else trayImage = trayImage.resize({ width: 20, height: 20 });
    tray = new Tray(trayImage);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    nativeTheme.on('updated', updateTray);
  } catch (error) { state.error = `无法创建托盘：${error.message}`; }
  win.on('minimize', (e) => { if (tray) { e.preventDefault(); hideWindow(); } });
  win.on('close', (e) => { if (!quitting && tray) { e.preventDefault(); hideWindow(); } });
  handle('get', snapshot);
  handle('refresh', refresh);
  handle('dismiss', () => { state.error = ''; publish(); });
  handle('choose', chooseDirectory);
  handle('detect', detectDirectory);
  handle('select', (directory) => selectDirectory(directory, true));
  handle('action', action);
  handle('open', openRemote);
  handle('check', checkUpdate);
  handle('update', update);
  handle('recover', recoverInstallation);
  handle('diagnose', diagnose);
  handle('repair', repair);
  handle('security', security);
  handle('logs', (kind) => exclusive('正在读取日志', async () => {
    const info = await installation(settings.root);
    state.logs = { kind, text: await readDiagnosticLogs(info, kind) };
  }));
  handle('folder', async () => {
    const info = await installation(settings.root);
    const error = await shell.openPath(info.root);
    if (error) throw new Error(error);
  });
  handle('login', async (value) => {
    if (!app.isPackaged || typeof value !== 'boolean') throw new Error('仅安装版支持登录启动。');
    app.setLoginItemSettings({ openAtLogin: value, ...(process.platform === 'darwin'
      ? { openAsHidden: true } : { args: ['--hidden'] }) });
    settings.launchAtLogin = app.getLoginItemSettings().openAtLogin;
    await saveSettings(); publish();
  });
  handle('quit', () => app.quit());
  await win.loadFile(path.join(here, 'dist', 'index.html'));
  // Recover the saved root before discovery validates its possibly interrupted
  // build. Never silently switch away from an installation needing recovery.
  const savedRoot = settings.root;
  if (savedRoot) {
    try { await recoverInstallation(); }
    catch (error) {
      if (error.code === 'ENOENT' && !await fs.stat(settings.root).catch(() => null)) state.recoveryRequired = false;
      else showError(error);
    }
  }
  if (!state.recoveryRequired) await restoreDirectory();
  if (settings.root && settings.root !== savedRoot && !state.recoveryRequired) {
    try { await recoverInstallation(); } catch (error) { showError(error); }
  }
  if (tray && (process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden))) {
    hideWindow(); void refresh();
  } else showWindow();
  timer = setInterval(() => void refresh(), 5000);
  }).catch((error) => { console.error(error); app.exit(1); });
}
