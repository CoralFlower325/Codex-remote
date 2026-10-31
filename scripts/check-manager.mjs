import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from '../desktop/node_modules/playwright/index.mjs';
import { manageAuthentication } from '../desktop/security.mjs';
import { run } from '../desktop/process.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const packaged = process.env.MANAGER_PACKAGED === '1';
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-manager-smoke-')));
const results = { platform: process.platform, arch: process.arch, packaged };
let desktopReady = true;
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/json/list') {
    response.statusCode = 503;
    response.end('[]');
  } else response.end(JSON.stringify({ ok: true, codex: 'ready',
    transport: desktopReady ? 'desktop' : 'standalone', passwordConfigured: true }));
});
let application;
async function until(read, expected, name) {
  for (let i = 0; i < 80; i++) {
    if (await read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Manager smoke check failed: ${name}`);
}
async function diagnosticVisible(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content').getBoundingClientRect();
    const message = document.querySelector('.content > .message').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth &&
      document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight + 1 &&
      message.top >= content.top && message.bottom <= content.bottom &&
      message.left >= content.left && message.right <= content.right;
  });
}
try {
  if (process.platform === 'darwin' && process.arch !== 'arm64') throw new Error('The macOS manager requires Apple Silicon acceptance.');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(path.join(fixture, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'dist-server/server'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'codex-remote', type: 'module', version }), 'utf8');
  await fs.writeFile(path.join(fixture, 'dist-server/server/index.js'), '// Synthetic fixture only.\n', 'utf8');
  for (const name of ['auth.js', 'session-store.js', 'cli/manage-auth.js']) {
    await fs.mkdir(path.dirname(path.join(fixture, 'dist-server/server', name)), { recursive: true });
    await fs.copyFile(path.join(root, 'dist-server/server', name), path.join(fixture, 'dist-server/server', name));
  }
  await fs.mkdir(path.join(fixture, 'data'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'dist-server/server/config.js'),
    `export const config = ${JSON.stringify({ dataDir: path.join(fixture, 'data'),
      authFile: path.join(fixture, 'data/auth.json'), secretFile: path.join(fixture, 'data/session-secret'), sessionDays: 30 })};\n`);
  await fs.writeFile(path.join(fixture, '.env'),
    `PORT=${server.address().port}\nCODEX_DESKTOP_DEBUG_PORT=${server.address().port}\n`, 'utf8');
  const status = JSON.stringify({ running: true, installed: true, enabled: true, conflict: false, tunnelManaged: false });
  const statusFile = path.join(fixture, 'service-state.json');
  await fs.writeFile(statusFile, status, 'utf8');
  await fs.writeFile(path.join(fixture, 'scripts/remote-control-windows.ps1'),
    `param([string]$Action,[switch]$Json)\nif ($Action -eq "Start") { exit 0 }\nif ($Action -ne "Status") { throw "Synthetic fixture" }\nGet-Content -LiteralPath (Join-Path $PSScriptRoot '../service-state.json') -Raw\n`, 'utf8');
  await fs.writeFile(path.join(fixture, 'scripts/remote-control-macos.sh'),
    `#!/bin/bash\nset -eu\n[[ "$1" != Start ]] || exit 0\n[[ "$1" == Status ]] || exit 1\ncat "$(dirname "$0")/../service-state.json"\n`, 'utf8');
  await manageAuthentication(fixture, { action: 'password', password: 'synthetic initial password' });
  await run('node', ['--input-type=module', '-e',
    `import {issueSession} from ${JSON.stringify(pathToFileURL(path.join(fixture, 'dist-server/server/auth.js')).href)};
     process.stdout.write(JSON.stringify([issueSession('iPhone Safari/605'),issueSession('Windows Chrome/100')]))`],
  { cwd: fixture });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: packaged ? path.join(root, 'output/manager', process.platform === 'darwin'
      ? 'mac-arm64/Codex Remote Manager.app/Contents/MacOS/Codex Remote Manager'
      : 'win-unpacked/Codex Remote Manager.exe') : require('../desktop/node_modules/electron'),
    args: [...(packaged ? [] : [path.join(root, 'desktop'), `--installation=${fixture}${path.sep}.`]),
      `--user-data-dir=${path.join(fixture, 'profile')}`], cwd: fixture, env, timeout: 60_000
  });
  const page = await application.firstWindow();
  if (packaged) {
    await until(() => page.evaluate(async () => Boolean((await window.manager.get()).value.root)), true, 'automatic installation discovery');
    await until(() => page.evaluate(async () => (await window.manager.get()).value.busy), '', 'discovery finished');
    results.automaticDiscovery = true;
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, fixture);
    const selected = await page.evaluate(() => window.manager.choose());
    if (!selected.ok) throw new Error(selected.error);
    results.legacyProbe = await application.evaluate(async ({ app }, directory) => {
      const { execFile } = process.getBuiltinModule('node:child_process');
      const base = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
      const args = process.platform === 'darwin' ? [base + '/status-macos.sh', directory]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', base + '/status-windows.ps1', '-Root', directory];
      return new Promise((resolve, reject) => execFile(process.platform === 'darwin' ? '/bin/bash' : 'powershell.exe',
        args, { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
    }, fixture);
  }
  if (process.platform === 'darwin') await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.__managerDockEvents = [];
    const record = (kind) => globalThis.__managerDockEvents.push({
      kind, time: Date.now(), dock: app.dock.isVisible(), visible: BrowserWindow.getAllWindows()[0]?.isVisible()
    });
    const hide = app.dock.hide.bind(app.dock); const show = app.dock.show.bind(app.dock);
    app.dock.hide = () => { record('dock.hide'); return hide(); };
    app.dock.show = () => { record('dock.show'); return show(); };
    app.on('activate', () => record('activate'));
    for (const name of ['show', 'hide', 'minimize', 'restore']) {
      BrowserWindow.getAllWindows()[0].on(name, () => record(name));
    }
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await until(() => page.evaluate(async () => (await window.manager.get()).value.status?.state), 'healthy', 'synthetic health');
  results.health = 'healthy';
  await application.evaluate(({ Tray }) => {
    globalThis.__trayImages = [];
    const original = Tray.prototype.setImage;
    Tray.prototype.setImage = function(image) {
      const bytes = image.toBitmap();
      let maxAlpha = 0, transparent = 0;
      for (let i = 3; i < bytes.length; i += 4) {
        maxAlpha = Math.max(maxAlpha, bytes[i]);
        if (bytes[i] === 0) transparent++;
      }
      globalThis.__trayImages.push({ maxAlpha, transparent, template: image.isTemplateImage() });
      return original.call(this, image);
    };
  });
  await fs.writeFile(statusFile, JSON.stringify({ ...JSON.parse(status), running: false }), 'utf8');
  await page.evaluate(() => window.manager.refresh());
  const dim = await application.evaluate(() => globalThis.__trayImages.at(-1));
  if (!dim || dim.maxAlpha <= 0 || dim.maxAlpha >= 200 || !dim.transparent ||
      (process.platform === 'darwin' && !dim.template)) throw new Error('Stopped tray icon is not translucent');
  await fs.writeFile(statusFile, status, 'utf8');
  await page.evaluate(() => window.manager.refresh());
  const bright = await application.evaluate(() => globalThis.__trayImages.at(-1));
  if (!bright || bright.maxAlpha < 230 || bright.maxAlpha <= dim.maxAlpha || !bright.transparent ||
      (process.platform === 'darwin' && !bright.template)) throw new Error('Running tray icon is not opaque: ' + JSON.stringify({ dim, bright }));
  results.trayStateImages = { dim, bright };
  const beforeTheme = await application.evaluate(({ nativeTheme }) => {
    const previous = nativeTheme.themeSource;
    nativeTheme.themeSource = 'dark'; nativeTheme.emit('updated');
    nativeTheme.themeSource = 'light'; nativeTheme.emit('updated');
    nativeTheme.themeSource = previous; nativeTheme.emit('updated');
    return globalThis.__trayImages.every(image => image.transparent > 0);
  });
  if (!beforeTheme) throw new Error('Tray theme transition lost transparency');
  results.trayThemeTransition = true;
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  });
  if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration) throw new Error('Unsafe preferences');
  results.preferences = preferences;
  await fs.mkdir(path.join(root, 'output/manager-smoke'), { recursive: true });
  for (const [width, height] of [[480, 690], [400, 550], [780, 800]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('footer').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && footer.bottom <= innerHeight + 1;
    });
    if (!layout) throw new Error(`Layout overflow at ${width}`);
    await page.screenshot({ path: path.join(root, `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}-${width}.png`) });
  }
  results.viewports = [480, 400, 780];
  desktopReady = false;
  await page.evaluate(() => window.manager.refresh());
  await until(() => page.evaluate(async () => (await window.manager.get()).value.status?.state), 'degraded', 'Desktop unavailable');
  const warning = await page.evaluate(async () => {
    const state = (await window.manager.get()).value;
    return { messages: state.status.diagnostics, error: state.error };
  });
  if (warning.messages.length !== 1 || warning.error || !warning.messages[0].includes(`127.0.0.1:${server.address().port}`)) {
    throw new Error('Missing Desktop diagnostic');
  }
  await page.getByRole('status').filter({ hasText: warning.messages[0] }).waitFor();
  const started = await page.evaluate(() => window.manager.action('Start'));
  if (!started.ok) throw new Error('Desktop absence incorrectly failed Start: ' + started.error);
  if (await page.evaluate(async () => Boolean((await window.manager.get()).value.error))) {
    throw new Error('Desktop absence left a startup error');
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(400, 550));
  const warningLayout = await diagnosticVisible(page);
  if (!warningLayout) throw new Error('Desktop diagnostic layout overflow');
  await page.screenshot({ path: path.join(root, `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}-desktop-unavailable.png`) });
  const second = path.join(fixture, 'codex-remote');
  for (const file of ['package.json', '.env', 'service-state.json', 'dist-server/server/index.js',
    'scripts/remote-control-windows.ps1', 'scripts/remote-control-macos.sh']) {
    await fs.mkdir(path.dirname(path.join(second, file)), { recursive: true });
    await fs.copyFile(path.join(fixture, file), path.join(second, file));
  }
  const detected = await page.evaluate(() => window.manager.detect());
  if (!detected.ok) throw new Error(detected.error);
  const discovered = await page.evaluate(async () => (await window.manager.get()).value);
  if (discovered.root !== fixture || !discovered.installations.some((item) => item.root === second)) {
    throw new Error('Discovery did not preserve the current selection or find a nearby installation');
  }
  await page.getByRole('combobox').waitFor();
  if (!await diagnosticVisible(page)) throw new Error('Diagnostic hidden by multiple installation choices');
  await page.screenshot({ path: path.join(root, `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}-multiple-installations.png`) });
  await page.getByRole('combobox').selectOption(second);
  await until(() => page.evaluate(async () => (await window.manager.get()).value.root), second, 'selected discovered installation');
  await until(() => page.evaluate(async () => (await window.manager.get()).value.busy), '', 'selection finished');
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, fixture);
  const chosen = await page.evaluate(() => window.manager.choose());
  if (!chosen.ok) throw new Error(chosen.error);
  const manual = await page.evaluate(async () => (await window.manager.get()).value);
  if (manual.root !== fixture || manual.installations.length) throw new Error('Manual selection retained outdated discovery choices');
  results.multipleInstallations = true;
  desktopReady = true;
  await page.evaluate(() => window.manager.refresh());
  await until(() => page.evaluate(async () => (await window.manager.get()).value.status?.state), 'healthy', 'Desktop recovery');
  await page.getByText(warning.messages[0], { exact: true }).waitFor({ state: 'detached' });
  results.desktopDiagnosticRecovers = true;
  results.startWithDesktopPending = true;
  const nativeNetwork = await application.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url, { credentials: 'omit' });
    return (await response.json()).ok;
  }, `http://127.0.0.1:${server.address().port}/health`);
  if (!nativeNetwork) throw new Error('Native manager network probe failed.');
  results.nativeNetwork = true;
  await application.evaluate(({ net }) => {
    const original = net.fetch.bind(net);
    net.fetch = (url, options) => String(url).startsWith('https://api.github.com/repos/CoralFlower325/')
      ? Promise.reject(new Error('Synthetic release network failure')) : original(url, options);
  });
  const failed = await page.evaluate(() => window.manager.check());
  if (failed.ok) throw new Error('Synthetic network failure was ignored');
  await page.evaluate(() => window.manager.refresh());
  const failure = await page.evaluate(async () => (await window.manager.get()).value);
  if (!failure.error.includes('检查版本未完成') || failure.healthError ||
    !failure.events.some((event) => event.message.includes('检查版本未完成'))) {
    throw new Error('Operation error lost during health refresh');
  }
  if (await page.locator('.actions button').first().isDisabled()) throw new Error('Operation error blocked recovery controls');
  await page.locator('.message.error button').click();
  await page.locator('.message.error').waitFor({ state: 'detached' });
  if (await page.evaluate(async () => Boolean((await window.manager.get()).value.error))) {
    throw new Error('Operation error could not be dismissed');
  }
  results.operationErrorPreservedAndDismissible = true;
  const journal = path.join(fixture, 'output/manager-update/active.json');
  await fs.mkdir(path.dirname(journal), { recursive: true });
  await fs.writeFile(journal, '{damaged synthetic journal');
  const blocked = await page.evaluate(() => window.manager.action('Restart'));
  if (blocked.ok || !blocked.value.recoveryRequired) throw new Error('Damaged journal did not block service mutation.');
  await page.getByRole('button', { name: '重试恢复' }).waitFor();
  if (!await page.locator('.actions button').first().isDisabled()) throw new Error('Recovery guard did not disable controls.');
  await fs.rm(journal);
  await page.getByRole('button', { name: '重试恢复' }).click();
  await page.getByRole('button', { name: '重试恢复' }).waitFor({ state: 'detached' });
  if ((await page.evaluate(async () => (await window.manager.get()).value)).recoveryRequired) {
    throw new Error('Recovery guard did not clear after a completed retry.');
  }
  results.recoveryGuardAndRetry = true;
  await application.evaluate(({ net }, currentVersion) => {
    const original = net.fetch.bind(net);
    net.fetch = (url, options) => String(url).startsWith('https://api.github.com/repos/CoralFlower325/')
      ? Promise.resolve(new Response(JSON.stringify({ tag_name: `v${currentVersion}`, body: 'Synthetic release notes' })))
      : original(url, options);
  }, version);
  await page.evaluate(() => { window.__managerMarker = 'retained'; });
  const checked = await page.evaluate(() => window.manager.check());
  if (!checked.ok) throw new Error(checked.error);
  if (await page.evaluate(() => window.__managerMarker) !== 'retained') throw new Error('Current-version check reloaded');
  results.currentCheckPreservesWindow = true;
  await application.evaluate(({ net, app }) => {
    const original = net.fetch.bind(net);
    const version = app.getVersion();
    const tag = `manager-v${version}`;
    const names = process.platform === 'darwin'
      ? [`Codex-Remote-Manager-${version}-mac-arm64.zip`, 'latest-mac.yml']
      : [`Codex-Remote-Manager-${version}-win-x64.exe`, 'latest.yml'];
    net.fetch = (url, options) => String(url).includes('/releases?')
      ? Promise.resolve(new Response(JSON.stringify([{ tag_name: tag, body: '合成管理器摘要',
        assets: names.map(name => ({ name, size: 10, digest: 'sha256:' + 'a'.repeat(64),
          browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/${tag}/${name}` })) }])))
      : original(url, options);
  });
  const managerChecked = await page.evaluate(() => window.manager.managerCheck());
  if (!managerChecked.ok || managerChecked.value.managerUpdate.status !== 'current' ||
    managerChecked.value.managerUpdate.version !== managerChecked.value.version) {
    throw new Error('Independent manager current-version check failed');
  }
  if (await page.evaluate(() => window.__managerMarker) !== 'retained') throw new Error('Manager check reloaded window');
  results.managerCurrentCheckPreservesWindow = true;
  await page.getByRole('button', { name: '设备与密码', exact: true }).click();
  await until(() => page.evaluate(async () => (await window.manager.get()).value.security?.devices.length), 2, 'registered devices');
  await page.getByText('iPhone · Safari', { exact: true }).waitFor();
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('新密码', { exact: true }).fill('synthetic changed password');
  await page.getByLabel('确认新密码', { exact: true }).fill('different synthetic password');
  await page.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '两次输入的密码不一致' }).waitFor();
  await page.getByRole('button', { name: '清除操作提示' }).click();
  await page.getByLabel('确认新密码', { exact: true }).fill('synthetic changed password');
  await page.screenshot({ path: path.join(root, `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}-security.png`) });
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.getByRole('button', { name: '保存密码', exact: true }).click();
  await until(() => page.evaluate(async () => (await window.manager.get()).value.busy), '', 'cancelled password change');
  if ((await manageAuthentication(fixture, { action: 'list' })).devices.length !== 2) throw new Error('Cancelled password change revoked devices');
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.getByRole('button', { name: '撤销 iPhone · Safari 的认证', exact: true }).click();
  await until(() => page.evaluate(async () => (await window.manager.get()).value.security?.devices.length), 1, 'single device revoked');
  await page.getByLabel('新密码', { exact: true }).fill('synthetic changed password');
  await page.getByLabel('确认新密码', { exact: true }).fill('synthetic changed password');
  await page.getByRole('button', { name: '保存密码', exact: true }).click();
  await until(() => page.evaluate(async () => (await window.manager.get()).value.security?.devices.length), 0, 'password invalidated devices');
  if ((await page.evaluate(async () => JSON.stringify((await window.manager.get()).value))).includes('synthetic changed password')) {
    throw new Error('Password leaked into manager state');
  }
  const stored = await fs.readFile(path.join(fixture, 'data/auth.json'), 'utf8');
  if (stored.includes('synthetic changed password')) throw new Error('Plaintext password persisted');
  results.authenticationManagement = true;
  await page.getByRole('button', { name: '概览', exact: true }).click();
  await fs.appendFile(path.join(fixture, '.env'), 'PUBLIC_ORIGIN=https://remote.example.test\n');
  await application.evaluate(({ net }) => {
    const original = net.fetch.bind(net);
    net.fetch = (url, options) => String(url).startsWith('https://remote.example.test/')
      ? Promise.reject(Object.assign(new Error('Synthetic timeout'), { name: 'TimeoutError' })) : original(url, options);
  });
  await page.evaluate(() => window.manager.refresh());
  await page.getByText('待确认', { exact: true }).waitFor();
  await page.getByRole('button', { name: '诊断公网连接' }).click();
  await until(() => page.evaluate(async () => (await window.manager.get()).value.connectionReport?.state), 'unknown', 'uncertain public diagnosis');
  await page.getByRole('region', { name: '连接诊断' }).getByText(/尚不能确认公网入口故障/).waitFor();
  const externalRepair = await page.evaluate(() => window.manager.repair('Tunnel'));
  if (externalRepair.ok || !externalRepair.error.includes('外部工具')) throw new Error('External tunnel was incorrectly adopted');
  await page.getByRole('button', { name: '清除操作提示' }).click();
  await page.getByRole('button', { name: '收起连接诊断' }).click();
  await fs.writeFile(path.join(fixture, 'data/server.err.log'), 'password=synthetic-log-secret\nSynthetic service log');
  await page.locator('.log-view summary').click();
  await page.getByRole('button', { name: '服务日志', exact: true }).click();
  await page.getByLabel('运行日志内容').waitFor();
  if ((await page.getByLabel('运行日志内容').textContent()).includes('synthetic-log-secret')) throw new Error('Log secret not redacted');
  results.actionableDiagnostics = true;
  await page.locator('.log-view summary').click();
  await page.locator('.content').evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => window.manager.dismiss());
  const actual = await page.evaluate(async () => (await window.manager.get()).value);
  await application.evaluate(({ BrowserWindow }, value) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__managerOriginalSend = contents.send.bind(contents);
    // Keep the synthetic update stable across real health polling and resize.
    contents.send = (channel, ...args) => globalThis.__managerOriginalSend(channel,
      ...(channel === 'manager:state' ? [value] : args));
    contents.send('manager:state', value);
  },
  { ...actual, result: '', busy: '下载并安装依赖', updateProgress: { percent: 18, step: 'dependencies',
    title: '下载并安装依赖', detail: '正在临时目录安装依赖；网络较慢时此步骤可能持续数分钟。',
    startedAt: Date.now() - 90_000, stepStartedAt: Date.now() - 70_000,
    lastOutputAt: Date.now() - 40_000, endedAt: null, status: 'running',
    logs: [{ time: Date.now(), message: 'npm http fetch synthetic dependency' }] } });
  await page.getByRole('progressbar', { name: '更新进度' }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 5500));
  for (const [width, height] of [[400, 550], [480, 690], [780, 800]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    if (await page.getByRole('progressbar').getAttribute('value') !== '18') throw new Error('Wrong progress value');
    const visible = await page.evaluate(() => {
      const content = document.querySelector('.content').getBoundingClientRect();
      const bar = document.querySelector('progress').getBoundingClientRect();
      return bar.top >= content.top && bar.bottom <= content.bottom &&
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight + 1;
    });
    if (!visible) throw new Error('Update progress hidden or overflowing');
    if (!await page.locator('.actions button').first().isDisabled()) throw new Error('Update controls not locked');
    await page.screenshot({ path: path.join(root, `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}-progress-${width}.png`) });
  }
  await application.evaluate(({ BrowserWindow }, value) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send = globalThis.__managerOriginalSend;
    delete globalThis.__managerOriginalSend;
    contents.send('manager:state', value);
  }, actual);
  await page.getByRole('progressbar').waitFor({ state: 'detached' });
  results.updateProgressVisible = true;
  await page.getByRole('button', { name: '版本更新', exact: true }).click();
  const managerBaseline = actual.managerUpdate;
  for (const updateStatus of ['available', 'downloading', 'downloaded', 'installing', 'error', 'completed', 'unsigned-mac']) {
    const synthetic = { ...managerBaseline, status: updateStatus === 'unsigned-mac' ? 'available' : updateStatus,
      version: '9.0.0', notes: '## 管理器 9.0.0\n\n- 合成更新摘要，用于检查排版。',
      detail: updateStatus === 'installing' ? '正在备份管理器程序与设置。' : '合成状态，不执行真实更新。',
      percent: updateStatus === 'downloading' ? 37 : null, transferred: 37 * 1024 ** 2,
      total: 100 * 1024 ** 2, bytesPerSecond: 3 * 1024 ** 2,
      error: updateStatus === 'error' ? '管理器更新未完成：合成网络中断。' : '',
      blocked: updateStatus === 'unsigned-mac' ? '此 Mac 管理器尚未使用开发者证书签名，暂不能自动安装；请通过安装包升级。' : '',
      backup: updateStatus === 'completed' ? 'synthetic-backup' : '' };
    await application.evaluate(({ BrowserWindow }, value) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      globalThis.__managerOriginalSend ??= contents.send.bind(contents);
      contents.send = (channel, ...args) => globalThis.__managerOriginalSend(channel,
        ...(channel === 'manager:state' ? [value] : args));
      contents.send('manager:state', value);
    }, { ...actual, busy: updateStatus === 'downloading' ? '正在下载管理器更新' : '', managerUpdate: synthetic });
    for (const [width, height] of [[400, 550], [480, 690]]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      await page.getByRole('region', { name: '管理器更新' }).scrollIntoViewIfNeeded();
      if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight + 1)) {
        throw new Error(`Manager update layout overflow: ${updateStatus}/${width}`);
      }
      if (updateStatus === 'downloading' &&
        await page.getByRole('progressbar', { name: '管理器下载进度' }).getAttribute('value') !== '37') {
        throw new Error('Manager byte progress not rendered');
      }
      await page.screenshot({ path: path.join(root,
        `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}-manager-${updateStatus}-${width}.png`) });
    }
  }
  await application.evaluate(({ BrowserWindow }, value) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send = globalThis.__managerOriginalSend;
    delete globalThis.__managerOriginalSend;
    contents.send('manager:state', value);
  }, actual);
  results.managerUpdateStates = ['available', 'downloading', 'downloaded', 'installing', 'error', 'completed', 'unsigned-mac'];
  for (const operation of ['minimize', 'close']) {
    await application.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows()[0][action](), operation);
    await until(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), true, operation);
    if (process.platform === 'darwin') {
      await until(() => application.evaluate(({ app }) => app.dock.isVisible()), false, 'Dock hidden');
      results.dockHidden = true;
    }
    if (process.platform === 'darwin' && operation === 'minimize') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await application.evaluate(({ app }) => app.emit('activate'));
      results.activationRestoresWindow = true;
    } else await application.evaluate(({ app }) => app.emit('second-instance'));
    await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, 'reopen');
    if (process.platform === 'darwin') await until(() => application.evaluate(({ app }) => app.dock.isVisible()), true, 'Dock shown');
  }
  results.minimizeToTray = true;
  results.closeToTray = true;
  results.errors = errors;
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(root, `output/manager-smoke/${process.platform}-${packaged ? 'packaged' : 'source'}.json`), JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results));
} finally {
  if (application && process.platform === 'darwin') {
    console.log('Dock events: ' + JSON.stringify(await application.evaluate(() => globalThis.__managerDockEvents)));
  }
  await application?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(fixture, { recursive: true, force: true });
}
