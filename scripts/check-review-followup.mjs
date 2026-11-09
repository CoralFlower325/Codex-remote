import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { publicClientRouter } from '../dist-server/server/public-client-router.js';
import { filePreviewRouter } from '../dist-server/server/file-preview.js';
import { TerminalManager } from '../dist-server/server/terminal-manager.js';
import { handleTerminalSocket } from '../dist-server/server/terminal-socket.js';

// All native RPC is synthetic; only this fixture's terminal owns real local shells.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-review-'));
const roots = [path.join(directory, 'first'), path.join(directory, 'second # \u6587\u6863')];
await Promise.all(roots.map(root => fs.mkdir(root)));
const longDirectory = path.join(roots[1], 'a-long-directory-for-path-truncation', 'another-long-directory-for-the-inspector');
await fs.mkdir(longDirectory, { recursive: true });
const longFile = path.join(longDirectory, 'synthetic-review-output.md');
await fs.writeFile(longFile, '# Synthetic path preview\n\n**Formatted result**\n', 'utf8');
const model = { id: 'demo', model: 'demo', displayName: 'Demo', description: 'Synthetic model description',
  isDefault: true, defaultReasoningEffort: 'high',
  supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Synthetic high effort' }] };
const project = { id: 'synthetic-project', name: 'Synthetic project', roots: roots.map(path => ({ path })) };
const threads = [{ id: 'review', name: 'Synthetic review', cwd: roots[0], projectId: project.id,
  model: 'demo', preview: 'Synthetic request', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, permissionProfile: ':workspace' }];
const timing = { id: 't', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 };
const actions = [];
let rejectNextRoot = false;
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const terminals = new TerminalManager(directory);
const report = path.resolve('docs/pr-7-review.md').replace(/\\/g, '/');
const answer = `Synthetic result. [Review record](/${report})`;
const send = (socket, body) => socket.readyState === 1 && socket.send(JSON.stringify(body));
app.use(express.json());
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true, setupAllowed: false }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true, workspace: {
  threads: { data: threads, nextCursor: null }, models: { data: [model] }, projects: { data: [project] }
} }));
app.get('/api/threads', (_q, r) => r.json({ data: threads, nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [
  { id: ':workspace', allowed: true }, { id: ':read-only', allowed: true }, { id: ':danger-full-access', allowed: true }
], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/thread/open', (q, r) => r.json({ result: { thread: threads.find(t => t.id === q.query.threadId) },
  items: [{ turnId: 't', item: { type: 'fileChange', id: 'change', status: 'completed',
    changes: [{ path: longFile, kind: 'update', diff: '@@ -1 +1 @@\n-before\n+after' }] } },
  { turnId: 't', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: answer } }],
  turns: [timing], activeTurnId: null, nextCursor: null, turnsCursor: null }));
app.get('/api/thread/timings', (_q, r) => r.json({ turns: [timing], activeTurnId: null, turnsCursor: null }));
app.get('/api/thread/outline', (_q, r) => r.json({ turns: [], nextCursor: null }));
app.get('/api/thread/dock/goal', (_q, r) => r.json({ goal: null }));
app.get('/api/thread/dock/queue', (_q, r) => r.json({ data: [], nextCursor: null }));
app.get('/fixture/state', (_q, r) => r.json({ roots, actions, threads, report, longFile }));
app.post('/fixture/reject-root', (_q, r) => { rejectNextRoot = true; r.json({ ok: true }); });
app.use('/api/file-preview', filePreviewRouter((_q, _r, next) => next()));
app.use(publicClientRouter(path.resolve('dist/client')));
sockets.on('connection', (socket, request) => {
  if (request.url === '/ws/terminal') {
    handleTerminalSocket(socket, terminals);
    return;
  }
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => {
    const m = JSON.parse(String(raw)), p = m.params ?? {};
    if (m.type === 'ping') return send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') return send(socket, { type: 'sync.ready', epoch: 'review-followup', sequence: 0, resumed: true });
    if (m.type !== 'rpc') return;
    let result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result.data = p.parentThreadId || p.archived ? [] : threads;
    if (['thread/read', 'thread/resume'].includes(m.method)) result = { thread: threads.find(t => t.id === p.threadId) };
    if (m.method === 'thread/turns/list') result.data = [timing];
    if (m.method === 'model/list') result.data = [model];
    if (m.method === 'project/list') result.data = [project];
    if (m.method === 'thread/settings/update') {
      actions.push({ method: m.method, params: p });
      if (p.cwd && rejectNextRoot) {
        rejectNextRoot = false;
        return send(socket, { type: 'rpc.error', id: m.id, error: { code: -32000, message: 'Synthetic root change rejected' } });
      }
      const thread = threads.find(t => t.id === p.threadId);
      if (p.cwd && !roots.includes(p.cwd)) return send(socket, { type: 'rpc.error', id: m.id, error: { code: -32602, message: 'Invalid root' } });
      if (p.cwd) thread.cwd = p.cwd;
      result = {};
    }
    if (m.method === 'thread/start') {
      actions.push({ method: m.method, params: p });
      const thread = { ...threads[0], id: `created-${threads.length}`, ...p };
      threads.push(thread);
      result = { thread, activePermissionProfile: { id: ':workspace' } };
    }
    if (m.method === 'turn/start') {
      actions.push({ method: m.method, params: p });
      result = { turn: { id: 'synthetic-started', status: 'inProgress' } };
    }
    send(socket, { type: 'rpc.result', id: m.id, result });
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({ origin, roots }));
async function close() {
  terminals.dispose();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
if (process.argv.includes('--serve')) {
  process.once('SIGINT', () => { void close().then(() => process.exit()); });
  process.once('SIGTERM', () => { void close().then(() => process.exit()); });
} else {
  const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ?? '../desktop/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ channel: process.env.REMOTE_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const output = 'output/playwright/review-followup';
  await fs.mkdir(output, { recursive: true });
  const results = [];
  try {
    for (const viewport of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
      threads[0].cwd = roots[0];
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block',
        deviceScaleFactor: viewport.deviceScaleFactor, hasTouch: viewport.mobile, isMobile: viewport.mobile,
        permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/?thread=review`);
      await page.locator('.message-stream').getByText('Synthetic result.', { exact: false }).waitFor();
      const picker = page.getByRole('combobox', { name: '\u9879\u76ee\u6839\u76ee\u5f55', exact: true });
      await picker.selectOption(roots[1]);
      await page.waitForFunction(root => document.querySelector('.workspace-path')?.textContent === root, roots[1]);
      assert(actions.some(a => a.method === 'thread/settings/update' && a.params.cwd === roots[1]));
      await page.getByRole('button', { name: '\u7ec8\u7aef', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.terminal-directory')?.textContent?.includes('\u5f53\u524d\u76ee\u5f55'));
      assert((await page.locator('.terminal-directory').textContent()).includes(roots[1]));
      if (viewport.name === 'desktop-2k') {
        const cd = root => process.platform === 'win32'
          ? `Set-Location -LiteralPath '${root.replace(/'/g, "''")}'`
          : `cd '${root.replace(/'/g, "'\\''")}'`;
        await page.locator('.terminal-screen').click();
        await page.keyboard.type(cd(roots[0]));
        await page.keyboard.press('Enter');
        await page.waitForFunction(root => document.querySelector('.terminal-directory')?.textContent?.includes(root), roots[0]);
        assert.equal(await picker.inputValue(), roots[1]);
        await page.getByRole('button', { name: '\u9690\u85cf\u7ec8\u7aef', exact: true }).click();
        await page.getByRole('button', { name: '\u7ec8\u7aef', exact: true }).click();
        await page.waitForFunction(root => document.querySelector('.terminal-directory')?.textContent?.includes(root), roots[0]);
        await page.waitForFunction(() => document.querySelectorAll('.terminal-tabs [role="tab"]').length > 0);
        const previousTabs = await page.locator('.terminal-tabs [role="tab"]').count();
        const previousSessions = terminals.list(terminals.open(roots[1])).map(session => session.id);
        await picker.selectOption(roots[0]);
        await page.waitForFunction(root => document.querySelector('.workspace-path')?.textContent === root, roots[0]);
        await picker.selectOption(roots[1]);
        await page.waitForFunction(root => document.querySelector('.workspace-path')?.textContent === root, roots[1]);
        await page.waitForFunction(root => document.querySelector('.terminal-directory')?.textContent?.includes(root), roots[1]);
        await page.waitForFunction(count => document.querySelectorAll('.terminal-tabs [role="tab"]').length === count, previousTabs + 1);
        assert.equal(await page.locator('.terminal-tabs [role="tab"]').count(), previousTabs + 1);
        assert(previousSessions.every(id => terminals.list(terminals.open(roots[1])).some(session => session.id === id)));
        await page.locator('.terminal-tabs [role="tab"]').first().click();
        await page.waitForFunction(root => document.querySelector('.terminal-directory')?.textContent?.includes(root), roots[0]);
        await page.locator('.terminal-tabs [role="tab"]').last().click();
        await page.waitForFunction(root => document.querySelector('.terminal-directory')?.textContent?.includes(root), roots[1]);
        await page.getByRole('button', { name: '\u9690\u85cf\u7ec8\u7aef', exact: true }).click();
        await page.getByRole('button', { name: '\u7ec8\u7aef', exact: true }).click();
        await page.waitForFunction(root => document.querySelector('.terminal-directory')?.textContent?.includes(root), roots[1]);
        await page.waitForFunction(count => document.querySelectorAll('.terminal-tabs [role="tab"]').length === count, previousTabs + 1);
        assert.equal(await page.locator('.terminal-tabs [role="tab"]').count(), previousTabs + 1);
        assert(previousSessions.every(id => terminals.list(terminals.open(roots[1])).some(session => session.id === id)));
      }
      await context.request.post(`${origin}/fixture/reject-root`);
      await picker.selectOption(roots[0]);
      await page.getByRole('alert').filter({ hasText: 'Synthetic root change rejected' }).waitFor();
      assert.equal(await picker.inputValue(), roots[1]);
      await page.reload();
      await picker.waitFor();
      assert.equal(await picker.inputValue(), roots[1]);
      await page.getByRole('link', { name: 'Review record', exact: true }).click();
      await page.locator('.file-preview-markdown h1').waitFor();
      assert((await page.locator('.file-preview-markdown').textContent()).includes('0.2.18'));
      const pathLabel = page.locator('.file-preview-path .path-text');
      assert.equal(await pathLabel.getAttribute('title'), path.resolve('docs/pr-7-review.md'));
      const visiblePath = await pathLabel.textContent();
      assert(visiblePath.includes('\u2026') || visiblePath === path.resolve('docs/pr-7-review.md'));
      await page.locator('.file-preview-path .path-copy').click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.resolve('docs/pr-7-review.md'));
      const raw = await context.request.get(new URL(await page.locator('.file-preview-tools a[download]').getAttribute('href'), origin).href);
      assert.equal(raw.status(), 200);
      assert((await raw.text()).includes('PR #7'));
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '\u4efb\u52a1\u68c0\u67e5\u5668', exact: true }).click();
      const pathRow = page.locator('.inspector-path-row').filter({ has: page.getByRole('link') });
      await pathRow.waitFor();
      const pathText = pathRow.locator('.path-text');
      assert.equal(await pathText.getAttribute('title'), longFile);
      await page.waitForFunction(() => document.querySelector('.inspector-path-row a .path-text')?.textContent);
      const renderedPath = await pathText.textContent();
      const relativePath = path.relative(roots[1], longFile).replace(/\\/g, '/');
      assert(renderedPath === relativePath || renderedPath.includes('\u2026'), `${viewport.name}: ${renderedPath}`);
      if (viewport.width <= 480) assert(renderedPath.includes('\u2026'), viewport.name);
      const pathSize = await pathText.evaluate(element => ({ visible: element.clientWidth, content: element.scrollWidth,
        font: getComputedStyle(element).font, text: element.textContent }));
      assert(pathSize.content <= pathSize.visible + 1, `${viewport.name}: ${JSON.stringify(pathSize)}`);
      await pathRow.locator('.path-copy').click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), longFile);
      await page.screenshot({ path: `${output}/paths-${viewport.name}.png` });
      await pathRow.getByRole('link').click();
      await page.locator('.file-preview-markdown h1').filter({ hasText: 'Synthetic path preview' }).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.composer-permission').click();
      await page.getByRole('menuitemradio').filter({ hasText: 'danger-full-access' }).waitFor();
      assert((await page.getByRole('menuitemradio').filter({ hasText: 'danger-full-access' }).textContent()).includes('never'));
      await page.keyboard.press('Escape');
      await page.locator('.composer-setting').click();
      await page.locator('.model-menu-note').waitFor();
      await page.getByRole('menuitem', { name: /^\u6a21\u578b/ }).click();
      await page.getByRole('menuitemradio').filter({ hasText: 'Synthetic model description' }).waitFor();
      await page.screenshot({ path: `${output}/model-${viewport.name}.png` });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Alt+n');
      await page.locator('.home-view').waitFor();
      await page.getByRole('button', { name: '\u7ec8\u7aef', exact: true }).click();
      await page.locator('.terminal-directory-notice').filter({ hasText: '\u5df2\u56de\u9000' }).waitFor();
      await page.getByRole('button', { name: '\u9009\u62e9\u9879\u76ee', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Synthetic project', exact: true }).click();
      assert.equal(await picker.inputValue(), roots[1]);
      await page.locator('.home-view textarea').fill('Synthetic root acceptance');
      await page.waitForFunction(() => {
        const send = document.querySelector('.home-view .composer-send');
        return send instanceof HTMLButtonElement && !send.disabled;
      });
      const previousStarts = actions.filter(a => a.method === 'thread/start').length;
      await page.getByRole('button', { name: '\u53d1\u9001\u4efb\u52a1', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.home-view'));
      const starts = actions.filter(a => a.method === 'thread/start');
      assert.equal(starts.length, previousStarts + 1);
      assert.equal(starts.at(-1).params.cwd, roots[1]);
      await page.screenshot({ path: `${output}/roots-${viewport.name}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      results.push({ viewport, rootSwitch: true, realTerminalCwd: true, reload: true,
        reviewPreviewAndDownload: true, pathClipboard: true, permissionAndModelDescriptions: true, fallbackNotice: true, rejectedRootRetained: true,
        newTaskRememberedRoot: true, errors });
      await context.close();
    }
    await fs.writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), 'utf8');
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
    await close();
  }
}
