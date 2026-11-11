import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ??
  '../desktop/node_modules/playwright/index.mjs');

// Isolated synthetic backend: never attach this acceptance run to Desktop.
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const model = { id: 'demo', model: 'demo', displayName: 'Codex Demo', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const skill = { name: 'synthetic-stop', path: '/skills/synthetic-stop/SKILL.md',
  description: 'Synthetic stop acceptance', enabled: true, interface: { displayName: 'Synthetic Stop' } };
const pluginSkills = [
  { name: 'documents', path: '/plugins/documents/SKILL.md', description: 'Create and edit documents',
    enabled: true, interface: { displayName: 'Documents' } },
  { name: 'pdf', path: '/plugins/pdf/SKILL.md', description: 'Read, create, and verify PDFs',
    enabled: true, interface: { displayName: 'PDF' } },
  { name: 'spreadsheets', path: '/plugins/spreadsheets/SKILL.md', description: 'Create and edit spreadsheets',
    enabled: true, interface: { displayName: 'Spreadsheets' } },
  { name: 'presentations', path: '/plugins/presentations/SKILL.md', description: 'Create and edit presentations',
    enabled: true, interface: { displayName: 'Presentations' } },
  { name: 'template-creator', path: '/plugins/template-creator/SKILL.md', description: 'Create reusable templates',
    enabled: true, interface: { displayName: 'Template Creator' } }
];
const threads = ['a', 'b'].map(id => ({ id, name: `Synthetic chat ${id.toUpperCase()}`, cwd: '/project',
  preview: 'Synthetic data', model: 'demo', createdAt: 1, updatedAt: id === 'a' ? 20 : 10,
  status: { type: 'idle' }, permissionProfile: ':workspace' }));
const turns = [
  { id: 'old', status: 'completed', startedAt: 1, completedAt: 50, durationMs: 49000 },
  { id: 'latest', status: 'completed', startedAt: 100, completedAt: 150, durationMs: 50000 }
];
const entry = (turnId, item) => ({ turnId, item, startedAtMs: null, completedAtMs: null });
const latest = [
  entry('latest', { type: 'userMessage', id: 'request', content: [{ type: 'text', text: 'A short request.' }] }),
  entry('latest', { type: 'agentMessage', id: 'response', phase: 'final_answer', text: 'A short final reply.' })
];
const older = [
  entry('old', { type: 'userMessage', id: 'old-user', content: [{ type: 'text', text: 'An earlier request.' }] }),
  entry('old', { type: 'agentMessage', id: 'old-comment', phase: 'commentary',
    text: Array.from({ length: 45 }, (_, i) => `Process paragraph ${i + 1}.`).join('\n\n') }),
  entry('old', { type: 'agentMessage', id: 'old-response', phase: 'final_answer',
    text: Array.from({ length: 30 }, (_, i) => `Earlier answer paragraph ${i + 1}.`).join('\n\n') })
];
const send = (socket, body) => socket.readyState === 1 && socket.send(JSON.stringify(body));
let submissions = [], pendingSend = null, historyReads = 0, actions = [];
let syncEnabled = true, socketAttempts = 0;
const httpPeers = new Map();
const event = (method, params) => {
  for (const socket of [...sockets.clients, ...httpPeers.values()])
    send(socket, { type: 'event', method, params: { threadId: 'a', ...params } });
};
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true, setupAllowed: false }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true, workspace: {
  threads: { data: threads, nextCursor: null }, models: { data: [model] }, projects: { data: [] } } }));
app.get('/api/threads', (_q, r) => r.json({ data: threads, nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [{ id: ':workspace', allowed: true }], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/thread/open', (q, r) => r.json({ result: { thread: threads.find(t => t.id === q.query.threadId) ?? threads[0] },
  items: latest, turns: turns.slice(1), nextCursor: 'older', turnsCursor: null, activeTurnId: null }));
app.get('/api/thread/history', (_q, r) => { historyReads++; r.json({ items: older, turns: [turns[0]], turnsCursor: null, nextCursor: null, activeTurnId: null }); });
app.get('/api/thread/timings', (_q, r) => r.json({ turns, turnsCursor: null, activeTurnId: null }));
app.get('/api/thread/dock/goal', (_q, r) => r.json({ goal: null }));
app.get('/api/thread/dock/queue', (_q, r) => r.json({ data: [], nextCursor: null }));
app.get('/api/thread/outline', (_q, r) => r.json({ turns: [], nextCursor: null }));
function receive(socket, raw) {
    const m = JSON.parse(String(raw)), p = m.params || {};
    if (m.type === 'ping') return send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') {
      if (!syncEnabled) return;
      send(socket, { type: 'questions.snapshot', counts: {} });
      send(socket, { type: 'server.request.snapshot', requests: [] });
      return send(socket, { type: 'sync.ready', epoch: 'composer', sequence: 0, resumed: true });
    }
    if (m.type !== 'rpc') return;
    let result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result.data = p.parentThreadId ? [] : threads;
    if (m.method === 'model/list') result.data = [model];
    if (['thread/read', 'thread/resume'].includes(m.method)) result = { thread: threads.find(t => t.id === p.threadId) ?? threads[0] };
    if (m.method === 'thread/turns/list') result.data = [...turns].reverse();
    if (m.method === 'skills/list') result = { data: [{ skills: [skill, ...pluginSkills], errors: [] }] };
    if (m.method === 'collaborationMode/list') result = { data: [{ mode: 'default' }, { mode: 'plan' }] };
    if (m.method === 'thread/goal/set') {
      actions.push({ method: m.method, params: p });
      const now = Math.floor(Date.now() / 1000);
      result = { goal: { threadId: p.threadId, objective: p.objective, status: p.status ?? 'active',
        tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now } };
    }
    if (['turn/start', 'turn/steer', 'turn/interrupt'].includes(m.method)) actions.push({ method: m.method, params: p });
    if (['thread/start', 'thread/fork'].includes(m.method) && p.ephemeral) {
      result = { thread: { ...threads[0], id: 'side', ephemeral: true } };
    }
    if (m.method === 'turn/interrupt') {
      send(socket, { type: 'rpc.result', id: m.id, result: {} });
      event('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted',
        startedAt: Math.floor(Date.now() / 1000) - 2, completedAt: Math.floor(Date.now() / 1000), durationMs: 2000 } });
      return;
    }
    if (m.method === 'turn/start') {
      if (p.threadId === 'side') {
        result = { turn: { id: 'side-running', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 2 } };
        send(socket, { type: 'rpc.result', id: m.id, result });
        return;
      }
      submissions.push(p);
      pendingSend = error => error
        ? send(socket, { type: 'rpc.error', id: m.id, error: { message: 'Synthetic send failure', code: -1 } })
        : send(socket, { type: 'rpc.result', id: m.id, result: { turn: null } });
      return;
    }
    send(socket, { type: 'rpc.result', id: m.id, result });
}
app.get('/api/connection', (q, r) => {
  socketAttempts++;
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  r.flushHeaders();
  const peer = { readyState: 1, send: body => r.write(`data: ${body}\n\n`) };
  httpPeers.set(q.query.id, peer);
  r.on('close', () => { peer.readyState = 3; httpPeers.delete(q.query.id); });
  send(peer, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(peer, { type: 'bridge.status', status: 'ready' });
});
app.post('/api/connection', express.json(), (q, r) => {
  const peer = httpPeers.get(q.query.id);
  if (!peer) return r.sendStatus(409);
  receive(peer, JSON.stringify(q.body));
  r.sendStatus(202);
});
app.use(express.static('dist/client'));
sockets.on('connection', socket => {
  socketAttempts++;
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => receive(socket, raw));
});
const directory = 'output/playwright/composer-028';
await fs.mkdir(directory, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: process.env.REMOTE_BROWSER_CHANNEL ?? 'chrome', headless: true });
const results = [];
try {
  for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
    submissions = []; pendingSend = null; historyReads = 0; syncEnabled = true; actions = [];
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/?thread=a`);
    const input = page.locator('.composer textarea');
    await page.locator('.message-stream').getByText('A short final reply.', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled);
    await page.evaluate(() => document.fonts.ready);
    const addButton = page.getByRole('button', { name: '添加文件和上下文', exact: true });
    await addButton.click();
    const addMenu = page.locator('.composer-popover--add');
    await addMenu.waitFor();
    await page.waitForTimeout(250);
    for (const label of ['文件和文件夹', '目标', '计划模式', '绘图', 'Documents', 'PDF', 'Spreadsheets', 'Presentations']) {
      await addMenu.getByText(label, { exact: true }).waitFor();
    }
    const addMenuGeometry = await addMenu.evaluate(menu => {
      const rect = menu.getBoundingClientRect();
      const plugins = menu.querySelector('.composer-add-plugins');
      const buttonHeights = [...menu.querySelectorAll('button')].filter(button => button.getClientRects().length)
        .map(button => button.getBoundingClientRect().height);
      return {
        top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        viewportHeight: innerHeight, viewportWidth: innerWidth,
        scrollHeight: plugins?.scrollHeight ?? 0, clientHeight: plugins?.clientHeight ?? 0,
        minButtonHeight: Math.min(...buttonHeights)
      };
    });
    assert(addMenuGeometry.top >= -1 && addMenuGeometry.bottom <= addMenuGeometry.viewportHeight + 1,
      `Add menu outside viewport: ${JSON.stringify(addMenuGeometry)}`);
    assert(addMenuGeometry.left >= -1 && addMenuGeometry.right <= addMenuGeometry.viewportWidth + 1,
      `Add menu horizontal overflow: ${JSON.stringify(addMenuGeometry)}`);
    if (size.mobile) assert(addMenuGeometry.minButtonHeight >= 44,
      `Add menu touch target below 44px: ${JSON.stringify(addMenuGeometry)}`);
    await page.screenshot({ path: `${directory}/${size.name}-add-menu.png` });
    const filesMenu = addMenu.getByRole('menuitem', { name: /文件和文件夹/ });
    await filesMenu.click();
    await addMenu.getByRole('menuitem', { name: '选择文件', exact: true }).waitFor();
    await addMenu.getByRole('menuitem', { name: '选择文件夹', exact: true }).waitFor();
    await filesMenu.click();
    await addMenu.getByRole('menuitem', { name: /计划模式/ }).click();
    await page.locator('.composer-plan').waitFor();
    await addButton.click();
    await page.locator('.composer-popover--add').getByRole('menuitem', { name: /退出计划模式/ }).click();
    await page.locator('.composer-plan').waitFor({ state: 'detached' });
    await addMenu.waitFor({ state: 'detached' });
    await input.fill('/');
    const slashMenu = page.locator('.slash-menu');
    await slashMenu.waitFor();
    await page.waitForTimeout(250);
    const planOption = slashMenu.getByRole('option', { name: /\/plan/ });
    const goalOption = slashMenu.getByRole('option', { name: /\/goal/ });
    await planOption.waitFor();
    await goalOption.waitFor();
    assert.equal(await planOption.isDisabled(), false);
    assert.equal(await goalOption.isDisabled(), false);
    const slashGeometry = await slashMenu.evaluate(menu => {
      const rect = menu.getBoundingClientRect();
      const options = menu.querySelector('.slash-menu-options');
      const buttonHeights = [...menu.querySelectorAll('button')].filter(button => button.getClientRects().length)
        .map(button => button.getBoundingClientRect().height);
      return {
        top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        viewportHeight: innerHeight, viewportWidth: innerWidth,
        scrollHeight: options?.scrollHeight ?? 0, clientHeight: options?.clientHeight ?? 0,
        minButtonHeight: Math.min(...buttonHeights)
      };
    });
    assert(slashGeometry.top >= -1 && slashGeometry.bottom <= slashGeometry.viewportHeight + 1,
      `Slash menu outside viewport: ${JSON.stringify(slashGeometry)}`);
    assert(slashGeometry.left >= -1 && slashGeometry.right <= slashGeometry.viewportWidth + 1,
      `Slash menu horizontal overflow: ${JSON.stringify(slashGeometry)}`);
    if (size.mobile) assert(slashGeometry.minButtonHeight >= 44,
      `Slash menu touch target below 44px: ${JSON.stringify(slashGeometry)}`);
    await page.screenshot({ path: `${directory}/${size.name}-slash-menu.png` });
    await page.keyboard.press('Escape');
    await slashMenu.waitFor({ state: 'detached' });
    const goalActionsBefore = actions.length;
    await input.fill('/goal Synthetic persistent objective');
    await page.locator('.slash-menu').getByRole('option').filter({ hasText: '/goal' }).click();
    await page.getByText('目标已启动', { exact: true }).waitFor();
    assert(actions.slice(goalActionsBefore).some(action => action.method === 'thread/goal/set' &&
      action.params.objective === 'Synthetic persistent objective' && action.params.origin === 'user'));
    await input.fill('');
    const toolbarGeometry = async composer => {
      const value = await composer.evaluate(root => {
        const outer = root.getBoundingClientRect();
        const nodes = [...root.querySelectorAll('.composer-toolbar button, .composer-toolbar .context-usage')];
        const controls = nodes.filter(node => node.getClientRects().length).map(node => {
          const rect = node.getBoundingClientRect();
          return { name: node.getAttribute('aria-label'), left: rect.left, right: rect.right,
            top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        });
        return { left: outer.left, right: outer.right, controls,
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(value.overflow, false, JSON.stringify(value));
      for (const control of value.controls) {
        assert(control.left >= value.left - 1 && control.right <= value.right + 1,
          `Control outside composer: ${JSON.stringify(control)}`);
        assert(control.width >= 12 && control.height >= 12, `Collapsed control: ${JSON.stringify(control)}`);
      }
      for (let i = 0; i < value.controls.length; i++) for (let j = i + 1; j < value.controls.length; j++) {
        const a = value.controls[i], b = value.controls[j];
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const sameRow = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        assert(overlap <= 1 || sameRow <= 1, `Controls overlap: ${JSON.stringify([a, b])}`);
      }
      const centers = value.controls.map(control => (control.top + control.bottom) / 2);
      assert(Math.max(...centers) - Math.min(...centers) <= 1, `Toolbar wrapped: ${JSON.stringify(value)}`);
      return value;
    };
    if (process.env.REMOTE_COMPOSER_LAYOUT_ONLY === '1') {
      event('turn/started', { turn: { id: 'layout-only', status: 'inProgress',
        startedAt: Math.floor(Date.now() / 1000) - 2 } });
      const composer = page.locator('.thread-screen > .thread-bottom .composer');
      await composer.locator('.composer-stop').waitFor();
      assert.equal(await composer.locator('.composer-send').count(), 0);
      assert.equal(await page.locator('.composer-active-mode').count(), 0);
      const emptyLayout = await toolbarGeometry(composer);
      await input.fill('Layout-only steering draft');
      await composer.locator('.composer-send').waitFor();
      assert.equal(await composer.locator('.composer-stop').count(), 0);
      assert.equal(await composer.getByRole('button', { name: /听写/ }).count(), 0);
      const contentLayout = await toolbarGeometry(composer);
      assert.equal(contentLayout.controls.filter(control =>
        ['发送任务', '发送补充要求', '引导当前任务', '加入队列'].includes(control.name)).length, 1);
      await page.screenshot({ path: `${directory}/${size.name}-mobile-composer.png` });
      results.push({ viewport: size.name, composerOnly: true, emptyLayout, contentLayout,
        singleRow: true, singlePrimaryAction: true, nativeQueuedComposer: true,
        nativeAddMenu: true, planGoalCommands: true, goalMutation: true, noDictation: true, errors });
      await context.close();
      continue;
    }
    const select = async id => {
      if (await page.locator('.app-shell').getAttribute('data-layout') === 'mobile')
        await page.getByRole('button', { name: '\u6253\u5f00\u4efb\u52a1\u5217\u8868', exact: true }).click();
      await page.locator(`.thread-row[data-thread-id="${id}"]`).click();
      await page.waitForFunction(id => document.querySelector(`.thread-row--active[data-thread-id="${id}"]`) &&
        !document.querySelector('.composer textarea')?.disabled, id);
      if (size.mobile) await page.waitForFunction(() =>
        document.querySelector('#workspace-sidebar').getBoundingClientRect().right <= 1);
    };
    await input.fill('Draft A');
    // Paste through the actual clipboard handler, with asynchronous reading.
    await page.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) {
        setTimeout(() => original.call(this, file), 500);
      };
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2a8270'; ctx.fillRect(0, 0, 160, 100);
      ctx.fillStyle = 'white'; ctx.font = '20px sans-serif'; ctx.fillText('Preview', 36, 58);
      const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste',
        { bubbles: true, cancelable: true, clipboardData: transfer }));
      FileReader.prototype.readAsDataURL = original;
    });
    await select('b');
    assert.equal(await page.locator('.composer-image').count(), 0);
    await input.fill('Draft B');
    await select('a');
    await page.locator('.composer-image img').waitFor();
    assert.equal(await input.inputValue(), 'Draft A');
    assert.equal(await page.locator('.composer-image').count(), 1);
    assert(await page.locator('.composer-image img').evaluate(img => img.complete && img.naturalWidth > 0));
    await page.locator('.composer-image .image-thumbnail').click();
    await page.locator('dialog.image-viewer[open]').waitFor();
    assert(await page.locator('.image-viewer-stage img').evaluate(img => img.complete && img.naturalWidth === 160));
    await page.screenshot({ path: `${directory}/${size.name}-preview.png` });
    await page.keyboard.press('Escape');
    await page.locator('.image-viewer').waitFor({ state: 'detached' });
    await page.screenshot({ path: `${directory}/${size.name}-draft.png` });
    // The historical anchor may need synthetic space on a short initial page.
    const stream = page.locator('.message-stream');
    await stream.hover();
    await stream.evaluate(e => { e.scrollTop = 0; });
    await page.waitForFunction(() => {
      const node = document.querySelector('.message-stream');
      if (!node || Math.abs(node.scrollTop) > 1) return false;
      const viewport = node.getBoundingClientRect();
      return [...node.querySelectorAll('[data-user-key]')].some(item => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > viewport.top + 1 && rect.top < viewport.top + 180;
      });
    });
    const anchorNode = await page.evaluate(() => {
      const stream = document.querySelector('.message-stream');
      const viewport = stream.getBoundingClientRect();
      const node = [...stream.querySelectorAll('[data-user-key]')].find(item => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom;
      });
      const row = node.closest('.timeline-row');
      return { key: node.dataset.userKey, top: node.getBoundingClientRect().top,
        rowTop: row?.getBoundingClientRect().top ?? null, scrollTop: stream.scrollTop };
    });
    await page.mouse.wheel(0, -180);
    try {
      await page.locator('.message-stream').getByText('Earlier answer paragraph 1.', { exact: true }).waitFor({ state: 'attached', timeout: 5000 });
    } catch (error) {
      console.log(JSON.stringify({ viewport: size.name, historyReads, errors,
        text: await stream.innerText(), state: await stream.evaluate(e => ({ top:e.scrollTop, height:e.clientHeight, scroll:e.scrollHeight })) }));
      await page.screenshot({ path: `${directory}/history-diagnostic.png` });
      throw error;
    }
    await page.waitForFunction(key => [...document.querySelectorAll('[data-user-key]')]
      .some(node => node.getAttribute('data-user-key') === key), anchorNode.key);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(100);
    let anchorSettled = true;
    try {
      await page.waitForFunction(anchor => {
        const node = [...document.querySelectorAll('[data-user-key]')]
          .find(item => item.getAttribute('data-user-key') === anchor.key);
        return node && Math.abs(node.getBoundingClientRect().top - anchor.top) < 2;
      }, anchorNode, { timeout: 2000 });
    } catch {
      anchorSettled = false;
    }
    const tailBefore = await page.locator('.message-stream-inner').evaluate(e => parseFloat(e.style.getPropertyValue('--reading-tail')) || 0);
    const anchorAfter = await page.evaluate(key => {
      const node = [...document.querySelectorAll('[data-user-key]')]
        .find(item => item.getAttribute('data-user-key') === key);
      const row = node.closest('.timeline-row');
      const stream = document.querySelector('.message-stream');
      return { top: node.getBoundingClientRect().top,
        rowTop: row?.getBoundingClientRect().top ?? null, scrollTop: stream.scrollTop };
    }, anchorNode.key);
    assert(anchorSettled && Math.abs(anchorAfter.top - anchorNode.top) < 2,
      `History anchor moved: ${anchorNode.top} -> ${anchorAfter.top}; key=${anchorNode.key}; ` +
      `before=${JSON.stringify(anchorNode)}; after=${JSON.stringify(anchorAfter)}`);
    await page.mouse.wheel(0, 200);
    await page.waitForFunction(() => !document.querySelector('.message-stream-inner').style.getPropertyValue('--reading-tail'));
    await stream.evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.waitForTimeout(220);
    const geometry = async () => page.evaluate(() => {
      const stream = document.querySelector('.message-stream'), inner = document.querySelector('.message-stream-inner');
      const last = inner.lastElementChild.getBoundingClientRect(), composer = document.querySelector('.composer').getBoundingClientRect();
      return { tail: inner.style.getPropertyValue('--reading-tail'), gap: composer.top - last.bottom,
        bottomDistance: stream.scrollHeight - stream.clientHeight - stream.scrollTop,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    let layout = await geometry();
    assert.equal(layout.tail, '');
    assert(layout.gap >= 0 && layout.gap <= 36, JSON.stringify(layout));
    assert(layout.bottomDistance <= 1);
    // Dynamic composer height must keep a reader at latest; collapsing activity
    // must not retain the old expanded height below the response.
    await input.fill(Array.from({ length: 8 }, (_, i) => `Draft line ${i}`).join('\n'));
    await page.waitForTimeout(100);
    layout = await geometry(); assert(layout.bottomDistance <= 1, JSON.stringify(layout));
    await page.locator('.turn-disclosure').click();
    await page.waitForTimeout(100);
    await page.locator('.turn-disclosure').click();
    await stream.evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.waitForTimeout(220);
    layout = await geometry(); assert(layout.gap <= 36, JSON.stringify(layout));
    await page.screenshot({ path: `${directory}/${size.name}-latest.png` });
    await input.fill('Submitted A');
    await page.locator('.composer-send').click();
    for (let i = 0; i < 100 && !pendingSend; i++) await page.waitForTimeout(20);
    assert(pendingSend);
    assert.equal(submissions[0].threadId, 'a');
    assert(submissions[0].input.some(e => e.type === 'image'));
    await select('b');
    assert.equal(await input.inputValue(), 'Draft B');
    pendingSend();
    await page.waitForTimeout(100);
    assert.equal(await input.inputValue(), 'Draft B');
    await select('a');
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('.composer-image').count(), 0);
    // Failed send must retain the image and text, including after navigation.
    const selectedImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2a8270'; ctx.fillRect(0, 0, 160, 100);
      ctx.fillStyle = 'white'; ctx.font = '20px sans-serif'; ctx.fillText('Preview', 36, 58);
      return canvas.toDataURL().split(',')[1];
    });
    await page.locator('.composer input[data-file-input]').setInputFiles(Array.from({ length: 5 }, (_, i) => ({
      name: `selected-${i}.png`, mimeType: 'image/png',
      buffer: Buffer.from(selectedImage, 'base64')
    })));
    await page.waitForFunction(() => document.querySelectorAll('.composer-image').length === 5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const tray = await page.locator('.composer-context-tray').evaluate(e => ({ width: e.clientWidth, scroll: e.scrollWidth }));
    if (size.width <= 402) assert(tray.scroll > tray.width);
    await page.screenshot({ path: `${directory}/${size.name}-multiple.png` });
    await input.fill('Retry draft');
    pendingSend = null;
    await page.locator('.composer-send').click();
    for (let i = 0; i < 100 && !pendingSend; i++) await page.waitForTimeout(20);
    assert(pendingSend); pendingSend(true);
    await page.waitForTimeout(100);
    await select('b'); await select('a');
    assert.equal(await input.inputValue(), 'Retry draft');
    assert.equal(await page.locator('.composer-image').count(), 5);
    await page.locator('.composer-image-remove').first().click();
    await select('b'); await select('a');
    assert.equal(await page.locator('.composer-image').count(), 4);
    const savedContext = await page.evaluate(() => sessionStorage.getItem('composer-context:v1'));
    assert(savedContext && savedContext.length * 2 <= 4 * 1024 * 1024);
    assert.equal(JSON.parse(savedContext).a.attachments.length, 4);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('draft:a')), 'Retry draft');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('thread') === 'a');
    await page.reload();
    await page.locator('.message-stream').getByText('A short final reply.', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled);
    assert.equal(await input.inputValue(), 'Retry draft');
    assert.equal(await page.locator('.composer-image').count(), 4);
    assert(await page.locator('.composer-image img').first().evaluate(img => img.complete && img.naturalWidth > 0));
    // Real native notifications, separate from browser transport recovery.
    if (await page.locator('.error-banner button').count()) await page.locator('.error-banner button').click();
    event('turn/started', { turn: { id: 'runtime-error', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 2 } });
    event('item/started', { turnId: 'runtime-error', item: { type: 'userMessage', id: 'runtime-user',
      content: [{ type: 'text', text: 'Synthetic native error request' }] } });
    event('error', { turnId: 'runtime-error', willRetry: true, error: { message: 'Reconnecting... 2/5',
      additionalDetails: 'Synthetic stream details',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } } });
    const nativeError = page.locator('[data-native-error="runtime-error"]');
    await nativeError.getByText('\u670d\u52a1\u5668\u7e41\u5fd9\uff0c\u6b63\u5728\u91cd\u65b0\u8fde\u63a5 2/5', { exact: true }).waitFor();
    assert.equal(await nativeError.getAttribute('role'), 'status');
    await nativeError.locator('summary').click();
    assert(await nativeError.getByText('Synthetic stream details', { exact: true }).isVisible());
    assert.equal(await page.locator('.connection-banner').count(), 0);
    await page.screenshot({ path: `${directory}/${size.name}-native-retry.png` });
    event('item/agentMessage/delta', { turnId: 'runtime-error', itemId: 'runtime-output', delta: 'Resumed native output.' });
    await nativeError.waitFor({ state: 'detached' });
    event('error', { turnId: 'runtime-error', willRetry: false, error: {
      message: 'unexpected status 429: {"error":{"message":"429 Too Many Requests: synthetic native failure"}}',
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } });
    await nativeError.getByText('429 Too Many Requests: synthetic native failure', { exact: true }).waitFor();
    assert.equal(await nativeError.getAttribute('role'), 'alert');
    assert.equal(await nativeError.locator('strong').count(), 0);
    const errorStyle = await nativeError.evaluate(e => {
      const s = getComputedStyle(e); return { color: s.color, background: s.backgroundColor, padding: s.padding, font: s.fontSize };
    });
    assert.equal(errorStyle.background, 'rgba(0, 0, 0, 0)');
    assert.equal(errorStyle.padding, '0px');
    assert.equal(errorStyle.font, '14px');
    await page.screenshot({ path: `${directory}/${size.name}-native-failed.png` });
    syncEnabled = false;
    for (const socket of sockets.clients) socket.terminate();
    const banner = page.locator('.connection-banner');
    await banner.waitFor();
    assert.equal((await banner.innerText()).replace(/\s+/g, ' ').trim(), 'Reconnecting Retry');
    assert.equal(await page.locator('.error-banner').count(), 0);
    assert.equal(await banner.locator('svg').count(), 0);
    const bannerStyle = await banner.evaluate(e => ({ color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor }));
    assert.equal(bannerStyle.background, 'rgb(255, 255, 255)');
    assert.equal(bannerStyle.color, 'rgb(98, 98, 98)');
    const attemptsBefore = socketAttempts;
    await banner.getByRole('button', { name: 'Retry', exact: true }).click();
    for (let i = 0; i < 100 && socketAttempts <= attemptsBefore; i++) await page.waitForTimeout(20);
    assert(socketAttempts > attemptsBefore);
    await page.screenshot({ path: `${directory}/${size.name}-reconnecting.png` });
    syncEnabled = true;
    await banner.getByRole('button', { name: 'Retry', exact: true }).click();
    await banner.waitFor({ state: 'detached' });
    assert.equal(submissions.length, 2);
    assert.equal(await input.inputValue(), 'Retry draft');
    assert.equal(await page.locator('.composer-image').count(), 4);
    // A busy turn must remain stoppable while its next text/image/skill draft
    // is retained. Exercise the real controls without issuing model requests.
    const chooseSkill = async composer => {
      await composer.locator('textarea').fill('/synthetic-stop');
      await page.getByRole('option').filter({ hasText: '/synthetic-stop' }).click();
      await composer.locator('.composer-context-chip').getByText('Synthetic Stop', { exact: true }).waitFor();
    };
    const activeActionGeometry = async composer => {
      await composer.locator('.composer-send').waitFor();
      assert.equal(await composer.locator('.composer-stop').count(), 0);
      assert.equal(await composer.getByRole('button', { name: /听写/ }).count(), 0);
      const value = await toolbarGeometry(composer);
      assert.equal(value.controls.filter(control =>
        ['发送任务', '发送补充要求', '引导当前任务', '加入队列'].includes(control.name)).length, 1,
        `Expected one send action: ${JSON.stringify(value)}`);
      return value;
    };
    const mainComposer = page.locator('.thread-screen > .thread-bottom .composer');
    await chooseSkill(mainComposer);
    await mainComposer.locator('textarea').fill('Retry draft');
    event('turn/started', { turn: { id: 'stop-with-draft', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 2 } });
    event('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: 1000 } });
    await mainComposer.locator('.context-usage').waitFor();
    const mainActiveActions = await activeActionGeometry(mainComposer);
    await page.screenshot({ path: `${directory}/${size.name}-main-single-send.png` });
    while (await mainComposer.locator('.composer-image-remove').count()) await mainComposer.locator('.composer-image-remove').first().click();
    if (await mainComposer.locator('.composer-context-chip button').count()) await mainComposer.locator('.composer-context-chip button').click();
    await mainComposer.locator('textarea').fill('');
    await mainComposer.locator('.composer-stop').waitFor();
    assert.equal(await mainComposer.locator('.composer-send').count(), 0);
    const mainActionCount = actions.length;
    await mainComposer.locator('.composer-stop').click();
    await mainComposer.locator('.composer-stop').waitFor({ state: 'detached' });
    assert.deepEqual(actions.slice(mainActionCount).map(action => action.method), ['turn/interrupt']);
    assert.deepEqual(actions.at(-1).params, { threadId: 'a', turnId: 'stop-with-draft' });
    // A temporary side chat steers directly while active. Stopping must retain
    // its own draft and never enqueue, start or steer that draft.
    await page.getByRole('button', { name: '\u6253\u5f00\u4efb\u52a1\u68c0\u67e5\u5668', exact: true }).click();
    await page.locator('.inspector-launcher button').first().click();
    const sideComposer = page.locator('.side-chat-view .composer');
    await sideComposer.locator('textarea').fill('Synthetic side start');
    await sideComposer.locator('.composer-send').click();
    await sideComposer.locator('.composer-stop').waitFor();
    await chooseSkill(sideComposer);
    await sideComposer.locator('textarea').fill('Keep side draft');
    await sideComposer.locator('input[data-file-input]').setInputFiles({
      name: 'side-image.png', mimeType: 'image/png', buffer: Buffer.from(selectedImage, 'base64')
    });
    await sideComposer.locator('.composer-image').waitFor();
    event('thread/tokenUsage/updated', { threadId: 'side',
      tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: 1000 } });
    await sideComposer.locator('.context-usage').waitFor();
    const sideActiveActions = await activeActionGeometry(sideComposer);
    await page.screenshot({ path: `${directory}/${size.name}-side-single-send.png` });
    assert.equal(await sideComposer.locator('textarea').inputValue(), 'Keep side draft');
    assert.equal(await sideComposer.locator('.composer-image').count(), 1);
    assert.equal(await sideComposer.locator('.composer-context-chip').count(), 1);
    assert.deepEqual(errors, []);
    results.push({ viewport: size.name, tailBefore, anchorDrift: anchorAfter.top - anchorNode.top, ...layout, pasteSwitch: true, imagePreview: true,
      fileSelection: true, sendWhileSwitching: true, failedSendRetained: true, removalRetained: true,
      nativeRetry: true, nativeFailure: true, errorStyle, bannerStyle, manualReconnect: true, noActionReplay: true,
      nativeAddMenu: true, planGoalCommands: true, goalMutation: true,
      mainActiveActions, sideActiveActions, singlePrimaryAction: true, stopAvailableWhenEmpty: true,
      noDictation: true, errors });
    await context.close();
  }
  await fs.writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
