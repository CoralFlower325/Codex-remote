import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from '../desktop/node_modules/playwright/index.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-manager-smoke-'));
const results = { platform: process.platform, arch: process.arch };
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ ok: true, codex: 'ready', transport: 'desktop', passwordConfigured: true }));
});
let application;
async function until(read, expected, name) {
  for (let i = 0; i < 80; i++) {
    if (await read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Manager smoke check failed: ${name}`);
}
try {
  if (process.platform === 'darwin' && process.arch !== 'arm64') throw new Error('The macOS manager requires Apple Silicon acceptance.');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(path.join(fixture, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'dist-server/server'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'codex-remote', version: '0.1.10' }), 'utf8');
  await fs.writeFile(path.join(fixture, 'dist-server/server/index.js'), '// Synthetic fixture only.\n', 'utf8');
  await fs.writeFile(path.join(fixture, '.env'), `PORT=${server.address().port}\n`, 'utf8');
  const status = JSON.stringify({ running: true, installed: true, enabled: true, conflict: false, tunnelManaged: false });
  await fs.writeFile(path.join(fixture, 'scripts/remote-control-windows.ps1'),
    `param([string]$Action,[switch]$Json)\nif ($Action -ne "Status") { throw "Read-only fixture" }\nWrite-Output '${status}'\n`, 'utf8');
  await fs.writeFile(path.join(fixture, 'scripts/remote-control-macos.sh'),
    `#!/bin/bash\nset -eu\n[[ "$1" == Status ]] || exit 1\nprintf '%s\\n' '${status}'\n`, 'utf8');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: require('../desktop/node_modules/electron'),
    args: [path.join(root, 'desktop'), `--installation=${fixture}`], env, timeout: 60_000
  });
  const page = await application.firstWindow();
  if (process.platform === 'darwin') await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.__managerDockEvents = [];
    const record = (kind) => globalThis.__managerDockEvents.push({
      kind, dock: app.dock.isVisible(), visible: BrowserWindow.getAllWindows()[0]?.isVisible()
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
    await page.screenshot({ path: path.join(root, `output/manager-smoke/${process.platform}-${width}.png`) });
  }
  results.viewports = [480, 400, 780];
  await application.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => String(url).startsWith('https://api.github.com/repos/CoralFlower325/')
      ? Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.1.10', body: 'Synthetic release notes' })))
      : original(url, options);
  });
  await page.evaluate(() => { window.__managerMarker = 'retained'; });
  const checked = await page.evaluate(() => window.manager.check());
  if (!checked.ok) throw new Error(checked.error);
  if (await page.evaluate(() => window.__managerMarker) !== 'retained') throw new Error('Current-version check reloaded');
  results.currentCheckPreservesWindow = true;
  for (const operation of ['minimize', 'close']) {
    await application.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows()[0][action](), operation);
    await until(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), true, operation);
    if (process.platform === 'darwin') {
      await until(() => application.evaluate(({ app }) => app.dock.isVisible()), false, 'Dock hidden');
      results.dockHidden = true;
    }
    await application.evaluate(({ app }) => app.emit('second-instance'));
    await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, 'reopen');
    if (process.platform === 'darwin') await until(() => application.evaluate(({ app }) => app.dock.isVisible()), true, 'Dock shown');
  }
  results.minimizeToTray = true;
  results.closeToTray = true;
  results.errors = errors;
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(root, `output/manager-smoke/${process.platform}.json`), JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results));
} finally {
  if (application && process.platform === 'darwin') {
    console.log('Dock events: ' + JSON.stringify(await application.evaluate(() => globalThis.__managerDockEvents)));
  }
  await application?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(fixture, { recursive: true, force: true });
}
