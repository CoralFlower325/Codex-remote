import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { chromium } from '../desktop/node_modules/playwright/index.mjs';

const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const target = '0.2.7';
const build = JSON.parse(await fs.readFile('dist/client/version.json', 'utf8'));
const model = { id: 'demo', model: 'demo', displayName: 'Demo', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
let current = pkg.version, available = false, offline = false, operation = null, installs = 0, platform = 'win32';
const snapshot = () => ({ currentVersion: current, platform, arch: platform === 'win32' ? 'x64' : 'arm64',
  supported: true, operation });
app.use(express.json());
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true, setupAllowed: false }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true,
  workspace: { threads: { data: [], nextCursor: null }, models: { data: [model] }, projects: { data: [] } } }));
app.get('/api/threads', (_q, r) => r.json({ data: [], nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [{ id: ':workspace', allowed: true }], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/remote-update', (_q, r) => offline ? r.sendStatus(503) : r.json(snapshot()));
app.post('/api/remote-update/check', (_q, r) => r.json({ ...snapshot(), available,
  canUpdate: true, latestVersion: available ? target : current, token: '11111111-1111-4111-8111-111111111111' }));
app.post('/api/remote-update/install', (q, r) => {
  installs++;
  operation = { id: q.body.id, version: target, fromVersion: current, status: 'running', updatedAt: Date.now(),
    progress: { percent: 18, step: 'runtime', title: '下载运行包', detail: '已下载 0.0 / 20.0 MB。',
      startedAt: Date.now(), stepStartedAt: Date.now(), endedAt: null, status: 'running' } };
  r.status(202).json(operation);
});
app.get('/remote-client/sw.js', async (_q, r) => {
  r.set('Service-Worker-Allowed', '/').type('js').send((await fs.readFile('dist/client/sw-origin.js', 'utf8'))
    .replaceAll(`"version":"${pkg.version}"`, `"version":"${target}"`));
});
app.get('/remote-client/version.json', (_q, r) => r.json({ ...build, version: target }));
app.get('/remote-client/', async (_q, r) => r.type('html').send((await fs.readFile('dist/client/index.html', 'utf8'))
  .replace(/((?:src|href)=["'])\/assets\//g, '$1/remote-client/assets/')));
app.use('/remote-client/assets', async (q, r, next) => {
  if (!q.path.endsWith('.js')) return next();
  const relative = q.path.slice(1);
  if (!/^[\w.-]+\.js$/.test(relative)) return r.sendStatus(404);
  // Synthetic second release: the app source is identical except its visible version.
  r.type('js').send((await fs.readFile(path.join('dist/client/assets', relative), 'utf8'))
    .replaceAll(`"${pkg.version}"`, `"${target}"`));
});
app.use('/remote-client', express.static('dist/client'));
app.use(express.static('dist/client'));
const send = (s, value) => s.readyState === 1 && s.send(JSON.stringify(value));
sockets.on('connection', socket => {
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.type === 'ping') send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') {
      send(socket, { type: 'questions.snapshot', counts: {} });
      send(socket, { type: 'server.request.snapshot', requests: [] });
      send(socket, { type: 'sync.ready', epoch: 'web-update', sequence: 0, resumed: true });
    }
    if (m.type === 'rpc') send(socket, { type: 'rpc.result', id: m.id,
      result: m.method === 'model/list' ? { data: [model] } : { data: [], nextCursor: null } });
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes('--serve')) {
  console.log(origin);
} else {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const directory = 'output/playwright/web-update-026';
  await fs.mkdir(directory, { recursive: true });
  const results = [];
  try {
    for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
      current = pkg.version; available = false; offline = false; operation = null; installs = 0;
      platform = size.mobile ? 'darwin' : 'win32';
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.deviceScaleFactor, isMobile: size.mobile, hasTouch: size.mobile });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let navigations = 0;
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
      await page.goto(origin);
      const open = async () => {
        if (await page.locator('.app-shell').getAttribute('data-layout') === 'mobile' &&
          !await page.locator('#workspace-sidebar').getAttribute('class').then(value => value.includes('sidebar--open'))) {
          await page.getByRole('button', { name: '打开任务列表', exact: true }).click();
        }
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('menuitem', { name: '检查 Remote 更新', exact: true }).click();
        await page.getByRole('dialog', { name: 'Remote 更新', exact: true }).waitFor();
      };
      await page.locator('.account-button').waitFor({ state: 'attached' });
      await open();
      await page.getByText('后端已是最新版本，无需更新。', { exact: true }).waitFor();
      assert.equal(installs, 0); assert.equal(navigations, 1);
      await page.getByRole('button', { name: '关闭 Remote 更新', exact: true }).click();
      available = true;
      await open();
      await page.getByRole('button', { name: `更新至 ${target}`, exact: true }).click();
      await page.getByRole('progressbar', { name: 'Remote 更新进度' }).waitFor();
      operation.progress.percent = 47; operation.progress.detail = '已下载 12.4 / 20.0 MB。';
      await page.waitForFunction(() => document.querySelector('progress')?.value === 47);
      await page.screenshot({ path: `${directory}/${size.name}-progress.png` });
      assert.equal(await page.locator('.app-update-notes').count(), 0);
      const geometry = await page.getByRole('dialog', { name: 'Remote 更新', exact: true }).evaluate(e => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          overflow: e.scrollWidth > e.clientWidth + 1 };
      });
      assert(geometry.left >= 0 && geometry.right <= size.width && geometry.top >= 0 &&
        geometry.bottom <= size.height && !geometry.overflow, JSON.stringify(geometry));
      await page.getByRole('button', { name: '关闭 Remote 更新', exact: true }).click();
      operation.progress.percent = 88; operation.progress.step = 'install'; operation.progress.title = '安装新版本';
      await page.waitForTimeout(1700); // The hidden dialog's monitor keeps running.
      offline = true;
      await open();
      await page.getByText('等待后端重新连接，已完成的进度保留。', { exact: true }).waitFor({ timeout: 12_000 });
      assert.equal(await page.locator('progress').getAttribute('value'), '88');
      assert.equal(installs, 1);
      await page.screenshot({ path: `${directory}/${size.name}-reconnect.png` });
      offline = false; current = target; operation.status = 'completed';
      operation.progress.percent = 100; operation.progress.status = 'completed'; operation.progress.endedAt = Date.now();
      await page.waitForFunction(target => document.querySelector('.account-version')?.textContent === target, target,
        { timeout: 30_000 });
      assert(navigations > 1, 'Successful backend update must refresh the browser.');
      await page.waitForTimeout(2300);
      const workerScript = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
      assert(workerScript.includes('/remote-client/sw.js'), workerScript);
      const privateCached = await page.evaluate(async () => {
        for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
          if (new URL(request.url).pathname.startsWith('/api/')) return true;
        }
        return false;
      });
      assert.equal(privateCached, false);
      assert.equal(installs, 1);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('remote-backend-update')), null);
      assert.equal(errors.length, 0, errors.join('\n'));
      results.push({ viewport: size.name, platform, installs, navigations, workerScript, privateCached, errors });
      await context.close();
      console.log(`PASS ${size.name}`);
    }
    await fs.writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}
