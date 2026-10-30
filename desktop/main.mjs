import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { health, installation, control, serviceStatus, portListening } from './controller.mjs';
import { latestRelease, prepareUpdate, installUpdate } from './updater.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const labels = {
  healthy: '运行正常', degraded: '需要检查', stopped: '已关闭',
  conflict: '安装目录冲突', unowned: '端口被其他服务使用'
};
let win; let tray; let timer; let quitting = false; let polling = null;
let dockTimer; let lastDockHide = 0;
let settings = { root: '', launchAtLogin: false };
let state = { status: null, busy: '', error: '', release: null, result: '', events: [] };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function event(message) {
  state.events = [{ time: Date.now(), message }, ...state.events].slice(0, 60);
}
function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('manager:state', snapshot());
  updateTray();
}
function snapshot() {
  return { ...state, root: settings.root, launchAtLogin: settings.launchAtLogin,
    packaged: app.isPackaged, version: app.getVersion(), platform: process.platform };
}
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings), 'utf8');
}
async function refresh() {
  if (polling) return polling;
  if (state.busy || !settings.root) return;
  polling = (async () => {
    try {
      state.status = await health(settings.root);
      state.error = '';
    } catch (error) {
      state.error = error.message;
      state.status = null;
    } finally { polling = null; publish(); }
  })();
  return polling;
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(dockTimer);
  if (process.platform === 'darwin') void app.dock.show();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  void refresh();
}
function hideWindow() {
  if (!tray) return;
  win.hide();
  if (process.platform === 'darwin') {
    clearTimeout(dockTimer);
    // Electron ignores repeated dock.hide calls within one second.
    dockTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) { app.dock.hide(); lastDockHide = Date.now(); }
    }, Math.max(0, 1100 - (Date.now() - lastDockHide)));
  }
}
function updateTray() {
  if (!tray) return;
  const text = state.error ? '状态检测失败' : labels[state.status?.state] || '未选择安装目录';
  tray.setToolTip(`Codex Remote · ${state.busy || text}`);
  const ready = Boolean(settings.root) && !state.busy && !state.error &&
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
function showError(error) {
  state.error = error.message; event('操作未完成'); publish();
}
async function exclusive(label, fn) {
  if (state.busy) throw new Error('已有操作正在进行。');
  // A read already in progress must finish before a mutation uses its snapshot.
  if (polling) await polling;
  if (state.busy) throw new Error('已有操作正在进行。');
  state.busy = label; state.error = ''; state.result = ''; event(label); publish();
  try { return await fn(); }
  catch (error) { showError(error); throw error; }
  finally { state.busy = ''; await refresh(); publish(); }
}
async function waitStopped() {
  for (let i = 0; i < 30; i++) {
    const info = await installation(settings.root);
    const service = await serviceStatus(info);
    if (!service.running && !await portListening(info.localUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('旧 Remote 仍在运行，已停止后续操作。');
}
async function stop() { await control(settings.root, 'Stop'); await waitStopped(); }
async function verify() {
  for (let i = 0; i < 6; i++) {
    const status = await health(settings.root);
    if (status.state === 'healthy') return;
    if (i < 5) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Remote 已启动，但健康检测尚未通过。');
}
async function action(kind) {
  if (!settings.root) throw new Error('请先选择安装目录。');
  if (!['Start', 'Stop', 'Restart'].includes(kind)) throw new Error('Invalid action.');
  return exclusive(kind === 'Start' ? '正在开启 Remote' : kind === 'Stop' ? '正在关闭 Remote' : '正在重启 Remote',
    async () => {
      if (kind !== 'Start') await stop();
      if (kind !== 'Stop') { await control(settings.root, 'Start'); await verify(); }
      event(kind === 'Stop' ? 'Remote 已关闭' : 'Remote 已启动');
    });
}
async function openRemote() {
  const info = await installation(settings.root);
  await shell.openExternal(info.publicUrl || info.localUrl);
}
async function checkUpdate() {
  return exclusive('正在检查更新', async () => {
    const info = await installation(settings.root);
    state.release = await latestRelease(info.version);
    state.result = state.release.available ? '' : `本机 ${info.version} 已是最新版本。`;
    event(state.release.available ? `发现新版本 ${state.release.version}` : '本机已是最新版本');
  });
}
async function update() {
  if (!state.release?.available) throw new Error('请先检查更新。');
  const release = { ...state.release };
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', title: '更新本机 Codex Remote',
    message: `更新到 ${release.version}？`,
    detail: '将检查文件冲突、备份并构建新版。安装时 Remote 会短暂离线。Codex Desktop 和私有数据保留。外部静态托管需另行同步。\n\n' + release.notes,
    buttons: ['取消', '更新本机'], defaultId: 0, cancelId: 0
  });
  if (response !== 1) return;
  return exclusive('正在准备更新', async () => {
    const current = await health(settings.root);
    if (['conflict', 'unowned'].includes(current.state)) throw new Error('请先解决服务归属或端口冲突。');
    const progress = (message) => { state.busy = message; event(message); publish(); };
    const prepared = await prepareUpdate(settings.root, release, progress);
    const result = await installUpdate(prepared, {
      stop, start: () => control(settings.root, 'Start'), verify,
      isRunning: async () => (await health(settings.root)).service.running, progress
    });
    state.release = null;
    state.result = `已安装 ${result.version}。备份：${result.backup}` +
      (result.wasRunning ? '' : '\nRemote 保持关闭。') +
      (result.edgeSyncRequired ? '\n若使用外部静态托管，请同步新版前端资源。' : '');
    event(`本机已更新到 ${result.version}`);
  });
}
async function chooseDirectory() {
  if (state.busy || polling) throw new Error('请等待当前操作完成。');
  const chosen = await dialog.showOpenDialog(win, { properties: ['openDirectory'],
    title: '选择已安装并构建的 Codex Remote 目录' });
  if (chosen.canceled) return;
  const info = await installation(chosen.filePaths[0]);
  settings.root = info.root; state.release = null; state.status = null; state.result = '';
  await saveSettings(); await refresh();
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
    catch (error) { return { ok: false, error: error.message }; }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    if (state.busy) { e.preventDefault(); showWindow(); return; }
    quitting = true; clearInterval(timer); clearTimeout(dockTimer);
  });
  app.whenReady().then(async () => {
  app.setAppUserModelId('io.github.coralflower325.codex-remote-manager');
  try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) }; } catch {}
  settings.launchAtLogin = app.isPackaged && app.getLoginItemSettings().openAtLogin;
  if (!app.isPackaged) {
    const rootArg = process.argv.find((arg) => arg.startsWith('--installation='));
    if (rootArg) settings.root = rootArg.slice('--installation='.length);
    else if (!settings.root) settings.root = path.dirname(here);
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
    const trayImage = process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png')) : image.resize({ width: 20, height: 20 });
    if (process.platform === 'darwin') trayImage.setTemplateImage(true);
    tray = new Tray(trayImage);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (error) { state.error = `无法创建托盘：${error.message}`; }
  win.on('minimize', (e) => { if (tray) { e.preventDefault(); hideWindow(); } });
  win.on('close', (e) => { if (!quitting && tray) { e.preventDefault(); hideWindow(); } });
  handle('get', snapshot);
  handle('refresh', refresh);
  handle('choose', chooseDirectory);
  handle('action', action);
  handle('open', openRemote);
  handle('check', checkUpdate);
  handle('update', update);
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
  if (tray && (process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden))) {
    hideWindow(); void refresh();
  } else showWindow();
  timer = setInterval(() => void refresh(), 5000);
  }).catch((error) => { console.error(error); app.exit(1); });
}
