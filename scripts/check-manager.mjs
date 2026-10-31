import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from '../desktop/node_modules/playwright/index.mjs';

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
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'codex-remote', version }), 'utf8');
  await fs.writeFile(path.join(fixture, 'dist-server/server/index.js'), '// Synthetic fixture only.\n', 'utf8');
  await fs.writeFile(path.join(fixture, '.env'),
    `PORT=${server.address().port}\nCODEX_DESKTOP_DEBUG_PORT=${server.address().port}\n`, 'utf8');
  const status = JSON.stringify({ running: true, installed: true, enabled: true, conflict: false, tunnelManaged: false });
  await fs.writeFile(path.join(fixture, 'scripts/remote-control-windows.ps1'),
    `param([string]$Action,[switch]$Json)\nif ($Action -eq "Start") { exit 0 }\nif ($Action -ne "Status") { throw "Synthetic fixture" }\nWrite-Output '${status}'\n`, 'utf8');
  await fs.writeFile(path.join(fixture, 'scripts/remote-control-macos.sh'),
    `#!/bin/bash\nset -eu\n[[ "$1" != Start ]] || exit 0\n[[ "$1" == Status ]] || exit 1\nprintf '%s\\n' '${status}'\n`, 'utf8');
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
  for (const file of ['package.json', '.env', 'dist-server/server/index.js',
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
