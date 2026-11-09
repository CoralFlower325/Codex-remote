import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ??
  '../desktop/node_modules/playwright/index.mjs');

// Exercise the built React app with isolated HTTP and realtime native fixtures.
// This server never discovers, connects to, or writes to a Desktop App Server.
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const model = { id: 'demo', model: 'demo', displayName: 'Synthetic model', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const threads = ['dock', 'history', 'live'].map(id => ({ id, name: `Synthetic ${id}`, cwd: '/synthetic-project',
  model: 'demo', preview: 'Synthetic data', createdAt: 1, updatedAt: 2,
  status: { type: id === 'dock' ? 'active' : 'idle' }, permissionProfile: ':workspace' }));
const goal = { threadId: 'dock', objective: 'Synthetic live goal', status: 'active', tokenBudget: null,
  tokensUsed: 10, timeUsedSeconds: 5, createdAt: 1, updatedAt: 10 };
const activeTiming = { id: 'active', status: 'inProgress', startedAt: 1, completedAt: null, durationMs: null };
const entry = (turnId, item) => ({ turnId, item, startedAtMs: null, completedAtMs: null });
const dockItems = [
  entry('active', { type: 'userMessage', id: 'request', content: [{ type: 'text', text: 'Synthetic request.' }] }),
  entry('active', { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Synthetic loaded history.' }),
  entry('active', { type: 'agentMessage', id: 'questions', delivery: 'async', text: '', questions: [
    { title: 'Synthetic choice?', options: ['Option A', 'Option B'] },
    { title: 'Synthetic details?', options: null }
  ] })
];
const history = Array.from({ length: 1200 }, (_, i) => [
  entry(`turn-${i}`, { type: 'userMessage', id: `user-${i}`, content: [{ type: 'text', text: `History request ${i}` }] }),
  entry(`turn-${i}`, { type: 'agentMessage', id: `answer-${i}`, phase: 'final_answer', text: `History answer ${i}` })
]).flat();
const timingFor = records => [...new Set(records.map(record => record.turnId))].map(id =>
  ({ id, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 }));
const approvalRequests = Array.from({ length: 3 }, (_, i) => ({
  requestId: `approval-${i}`, method: 'item/commandExecution/requestApproval',
  params: { threadId: 'dock', command: `echo synthetic-${i}`, reason: 'Synthetic approval details '.repeat(5) }
}));
const schedule = 'RRULE:FREQ=DAILY;BYHOUR=17;BYMINUTE=45;BYSECOND=0';
const automation = { id: 'synthetic', name: 'Synthetic schedule', prompt: 'Synthetic prompt',
  kind: 'cron', status: 'ACTIVE', rrule: schedule, executionEnvironment: 'local',
  model: 'demo', reasoningEffort: 'high', target: { type: 'projectless' }, createdAt: 1, updatedAt: 2 };
let rejectResume = true, rejectAnswer = true, queue = [], actions = [], historyReads = 0, automationWrites = [], anchorReads = 0;
let holdHistory = true, heldHistory = [];
let liveItems = history.slice(0, 800), liveAdvanced = false;
const send = (socket, body) => socket.readyState === 1 && socket.send(JSON.stringify(body));
const event = (method, params) => { for (const socket of sockets.clients) send(socket, { type: 'event', method, params }); };
app.use(express.json());
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true, setupAllowed: false }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true,
  workspace: { threads: { data: threads, nextCursor: null }, models: { data: [model] }, projects: { data: [] } } }));
app.get('/api/threads', (_q, r) => r.json({ data: threads, nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [{ id: ':workspace', allowed: true }], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/thread/open', (q, r) => {
  const isHistory = q.query.threadId === 'history';
  const isLive = q.query.threadId === 'live';
  const items = isLive ? liveAdvanced ? liveItems.slice(-40) : liveItems : isHistory ? history.slice(-40) : dockItems;
  const reply = () => r.json({ result: { thread: threads.find(thread => thread.id === q.query.threadId) },
    items, turns: isHistory || isLive ? timingFor(items) : [activeTiming], nextCursor: isHistory ? 'at:2360' : null,
    turnsCursor: null, activeTurnId: isHistory || isLive ? null : 'active' });
  if (isHistory || isLive || !holdHistory) reply(); else heldHistory.push(reply);
});
app.get('/api/thread/history', (q, r) => {
  historyReads++;
  const anchored = q.query.beforeItem ?? q.query.afterItem;
  if (anchored != null) anchorReads++;
  const anchorIndex = anchored == null ? -1 : history.findIndex(record =>
    record.turnId === q.query.turnId && record.item.id === anchored);
  const cursor = String(q.query.before ?? q.query.after ?? 'at:2400');
  const at = anchorIndex >= 0 ? anchorIndex + (q.query.afterItem == null ? 0 : 1) : Number(cursor.replace(/^at:/, ''));
  if (!Number.isInteger(at)) return r.status(400).json({ error: `Unexpected synthetic cursor ${cursor}` });
  const after = q.query.after != null || q.query.afterItem != null;
  const start = after ? at : Math.max(0, at - 100), end = after ? Math.min(history.length, at + 100) : at;
  const items = history.slice(start, end);
  r.json({ items, turns: timingFor(items), activeTurnId: null, turnsCursor: null,
    nextCursor: after ? end < history.length ? `at:${end}` : null : start ? `at:${start}` : null });
});
app.get('/api/thread/timings', (q, r) => r.json({ turns: q.query.threadId === 'dock' ? [activeTiming] : [],
  activeTurnId: q.query.threadId === 'dock' ? 'active' : null, turnsCursor: null }));
app.get('/api/thread/outline', (_q, r) => r.json({ turns: [], nextCursor: null }));
app.get('/api/thread/dock/goal', (q, r) => r.json({ goal: q.query.threadId === 'dock' ? goal : null }));
app.get('/api/thread/dock/queue', (q, r) => r.json({ data: q.query.threadId === 'dock' ? queue : [], nextCursor: null }));
app.get('/api/automations', (_q, r) => r.json({ automations: [automation], runs: [], timeZone: 'UTC' }));
app.patch('/api/automations/:id', (q, r) => { automationWrites.push(q.body); r.json({ ...automation, ...q.body }); });
app.use(express.static('dist/client'));
sockets.on('connection', socket => {
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => {
    const m = JSON.parse(String(raw)), p = m.params ?? {};
    if (m.type === 'ping') return send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') {
      send(socket, { type: 'server.request.snapshot', requests: approvalRequests });
      return send(socket, { type: 'sync.ready', epoch: 'audit-ui', sequence: 0, resumed: true });
    }
    if (m.type !== 'rpc') return;
    actions.push({ method: m.method, params: p });
    if (m.method === 'thread/resume' && p.threadId === 'dock' && rejectResume)
      return send(socket, { type: 'rpc.error', id: m.id, error: { message: 'Synthetic resume failure' } });
    if (m.method === 'turn/steer' && rejectAnswer) {
      rejectAnswer = false;
      return send(socket, { type: 'rpc.error', id: m.id, error: { code: -32000, message: 'Synthetic answer failure' } });
    }
    let result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result.data = p.archived || p.parentThreadId ? [] : threads;
    if (m.method === 'model/list') result.data = [model];
    if (['thread/resume', 'thread/read'].includes(m.method)) result = { thread: threads.find(thread => thread.id === p.threadId) };
    if (m.method === 'thread/turns/list') result.data = p.threadId === 'dock' ? [activeTiming] : [];
    if (m.method === 'thread/goal/get') result = { goal };
    if (m.method === 'thread/start') result = { thread: { ...threads[1], id: 'created', name: 'Synthetic created chat' } };
    if (m.method === 'turn/start')
      return send(socket, { type: 'rpc.error', id: m.id, error: { code: -32000, message: 'Synthetic first-send failure' } });
    if (m.method === 'turn/steer') result = {};
    send(socket, { type: 'rpc.result', id: m.id, result });
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.REMOTE_BROWSER_CHANNEL ?? 'chrome', headless: true });
const output = 'output/playwright/audit-ui';
await fs.mkdir(output, { recursive: true });
const results = [];
const only = process.argv.find(value => value.startsWith('--viewport='))?.slice('--viewport='.length);
try {
  for (const viewport of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
    if (only && only !== viewport.name) continue;
    rejectResume = true; rejectAnswer = true; actions = []; automationWrites = []; historyReads = 0; anchorReads = 0;
    holdHistory = true; heldHistory = [];
    liveItems = history.slice(0, 800); liveAdvanced = false;
    queue = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, clientUserMessageId: `u${i}`,
      input: [{ type: 'text', text: `Synthetic queued message ${i}`, text_elements: [] }] }));
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor, isMobile: viewport.mobile, hasTouch: viewport.mobile, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.locator('.thread-row[data-thread-id="dock"]').waitFor({ state: 'attached' });
      if (await page.locator('.app-shell').getAttribute('data-layout') === 'mobile')
        await page.getByRole('button', { name: '\u6253\u5f00\u4efb\u52a1\u5217\u8868', exact: true }).click();
      await page.locator('.thread-row[data-thread-id="dock"]').click();
      await page.getByText(goal.objective, { exact: true }).waitFor();
      await page.locator('.queued-message').first().waitFor();
      assert.equal(await page.locator('.message-stream').getByText('Synthetic loaded history.', { exact: true }).count(), 0);
      holdHistory = false; heldHistory.splice(0).forEach(reply => reply());
      await page.locator('.message-stream').getByText('Synthetic loaded history.', { exact: true }).waitFor();
      await page.getByRole('button', { name: '\u91cd\u8bd5\u8fde\u63a5\u6b64\u4f1a\u8bdd', exact: true }).waitFor();
      await page.locator('.composer textarea').fill('Draft while resume is unavailable');
      assert.equal(await page.locator('.composer-send').isDisabled(), true);
      rejectResume = false;
      await page.getByRole('button', { name: '\u91cd\u8bd5\u8fde\u63a5\u6b64\u4f1a\u8bdd', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.composer-send')?.disabled);
      await page.locator('.composer textarea').fill('');
      assert.equal(await page.locator('.thread-recovery').count(), 0);
      assert.equal(await page.locator('.error-banner').filter({ hasText: 'Synthetic resume failure' }).count(), 0);
      const layout = await page.evaluate(() => {
        const composer = document.querySelector('.thread-bottom > .composer-wrap').getBoundingClientRect();
        const pending = document.querySelector('.thread-pending').getBoundingClientRect();
        const stream = document.querySelector('.message-stream').getBoundingClientRect();
        return { composer: { top: composer.top, bottom: composer.bottom }, pending: { top: pending.top, bottom: pending.bottom },
          stream: { top: stream.top, bottom: stream.bottom }, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(layout.composer.bottom <= layout.height + 1 && layout.composer.top >= 0, JSON.stringify(layout));
      assert(layout.pending.bottom <= layout.composer.top + 1, JSON.stringify(layout));
      assert(layout.stream.bottom <= layout.pending.top + 1 && layout.stream.bottom > layout.stream.top, JSON.stringify(layout));
      assert.equal(layout.overflow, false);
      const questions = page.locator('.question-dock');
      assert.equal(await questions.locator('[aria-pressed="true"]').count(), 0);
      const submit = questions.getByRole('button', { name: '\u63d0\u4ea4\u56de\u7b54', exact: true });
      assert.equal(await submit.isDisabled(), true);
      await questions.getByRole('button', { name: 'Option B', exact: true }).click();
      const details = questions.getByRole('textbox', { name: 'Synthetic details?\uff1a\u81ea\u5b9a\u4e49\u7b54\u6848', exact: true });
      await details.fill('First line\nSecond line');
      await submit.click();
      await questions.getByRole('alert').filter({ hasText: 'Synthetic answer failure' }).waitFor();
      assert.equal(await details.inputValue(), 'First line\nSecond line');
      assert.equal(await questions.getByRole('button', { name: 'Option B', exact: true }).getAttribute('aria-pressed'), 'true');
      await submit.click();
      await questions.getByRole('status').waitFor();
      assert.equal(actions.filter(action => action.method === 'turn/steer').length, 2);
      assert.equal(actions.some(action => action.method === 'thread/queue/append'), false);
      queue = [];
      event('thread/queue/changed', { threadId: 'dock' });
      await page.locator('.queued-messages').waitFor({ state: 'detached' });
      await page.locator('.composer textarea').fill('Unsaved composer text');
      const send = page.locator('.composer-send');
      await send.waitFor();
      assert.equal(await send.getAttribute('aria-label'), '\u52a0\u5165\u961f\u5217');
      assert.equal(await page.getByRole('group', { name: '\u53d1\u9001\u65b9\u5f0f', exact: true }).count(), 0);
      assert.equal(await page.locator('.composer-active-mode').count(), 0);
      assert.equal(await page.locator('.composer-stop').count(), 0);
      await page.keyboard.press('Control+n');
      // The browser may handle Ctrl+N; the app must never turn it into task navigation.
      assert((await page.url()).includes('thread=dock'));
      await page.screenshot({ path: `${output}/docks-${viewport.name}.png` });
      if (await page.locator('.app-shell').getAttribute('data-layout') === 'mobile')
        await page.getByRole('button', { name: '\u6253\u5f00\u4efb\u52a1\u5217\u8868', exact: true }).click();
      await page.getByRole('button', { name: '\u81ea\u52a8\u4efb\u52a1', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '\u81ea\u52a8\u4efb\u52a1', exact: true });
      await dialog.getByRole('button', { name: '\u7f16\u8f91', exact: true }).click();
      assert.equal(await dialog.getByLabel('\u65f6\u95f4', { exact: true }).inputValue(), '17:45');
      await dialog.locator('.automations-editor textarea').first().fill('Prompt changed without schedule changes');
      await dialog.locator('button[type="submit"]').click();
      await dialog.locator('.automation-row').waitFor();
      assert.equal(automationWrites.length, 1);
      assert.equal(automationWrites[0].rrule, schedule);
      await page.screenshot({ path: `${output}/automation-${viewport.name}.png` });
      await dialog.getByRole('button', { name: '\u5173\u95ed\u81ea\u52a8\u4efb\u52a1', exact: true }).click();
      await page.goto(`${origin}/?thread=history`);
      await page.locator('.message-stream').getByText('History answer 1199', { exact: true }).waitFor();
      let maximumUsers = 0, worstAnchorDrift = 0;
      for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
        const stream = page.locator('.message-stream');
        await stream.hover();
        await stream.evaluate(node => { node.scrollTop = 0; });
        const previous = await page.locator('[data-user-key]').first().evaluate(node => ({
          key: node.dataset.userKey, top: node.getBoundingClientRect().top
        }));
        await page.mouse.wheel(0, -180);
        await page.waitForFunction(key => document.querySelector('[data-user-key]')?.getAttribute('data-user-key') !== key, previous.key);
        const drift = await page.evaluate(anchor => {
          const node = [...document.querySelectorAll('[data-user-key]')].find(node => node.getAttribute('data-user-key') === anchor.key);
          return node ? Math.abs(node.getBoundingClientRect().top - anchor.top) : Infinity;
        }, previous);
        worstAnchorDrift = Math.max(worstAnchorDrift, drift);
        maximumUsers = Math.max(maximumUsers, await page.locator('[data-user-key]').count());
        assert(maximumUsers <= 400, `${viewport.name}: unbounded history ${maximumUsers} user rows`);
        assert(drift <= 2, `${viewport.name}: reading anchor drift ${drift}`);
      }
      assert(maximumUsers >= 350, `${viewport.name}: not enough history pages exercised`);
      let forwardPages = 0;
      while (!(await page.locator('.message-stream').getByText('History answer 1199', { exact: true }).count()) && forwardPages++ < 15) {
        const last = await page.locator('[data-user-key]').last().getAttribute('data-user-key');
        await page.locator('.message-stream').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.waitForFunction(key => [...document.querySelectorAll('[data-user-key]')].at(-1)?.getAttribute('data-user-key') !== key, last);
        assert((await page.locator('[data-user-key]').count()) <= 400);
      }
      assert(forwardPages > 0, `${viewport.name}: trimmed newer edge was not recovered`);
      assert(anchorReads > 0, `${viewport.name}: exact item recovery anchor was not used`);
      await page.locator('.message-stream').getByText('History answer 1199', { exact: true }).waitFor();
      await page.getByRole('button', { name: '\u56de\u5230\u6700\u65b0\u6d88\u606f', exact: true }).click();
      await page.locator('.message-stream').getByText('History answer 1199', { exact: true }).waitFor();
      assert((await page.locator('[data-user-key]').count()) <= 400);
      await page.screenshot({ path: `${output}/history-${viewport.name}.png` });
      await page.goto(`${origin}/?thread=live`);
      await page.locator('.message-stream').getByText('History answer 399', { exact: true }).waitFor();
      const liveAnchor = await page.locator('.message-stream').evaluate(async stream => {
        stream.scrollTop = 300;
        stream.dispatchEvent(new TouchEvent('touchstart', { bubbles: true,
          touches: [new Touch({ identifier: 1, target: stream, clientY: 100 })] }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const top = stream.getBoundingClientRect().top;
        const node = [...stream.querySelectorAll('[data-user-key]')].find(node => node.getBoundingClientRect().bottom > top + 1);
        return { key: node.dataset.userKey, top: node.getBoundingClientRect().top };
      });
      liveAdvanced = true;
      for (let i = 0; i < 20; i++) {
        const turnId = `live-${i}`, item = { type: 'userMessage', id: `live-user-${i}`,
          content: [{ type: 'text', text: `Live request ${i}` }] };
        liveItems.push(entry(turnId, item));
        event('item/started', { threadId: 'live', turnId, item });
      }
      await page.waitForTimeout(250);
      assert.equal(await page.locator('[data-user-key]').count(), 400);
      const liveAnchorDrift = await page.evaluate(anchor => {
        const node = [...document.querySelectorAll('[data-user-key]')].find(node => node.dataset.userKey === anchor.key);
        return node ? Math.abs(node.getBoundingClientRect().top - anchor.top) : Infinity;
      }, liveAnchor);
      assert(liveAnchorDrift <= 2, `${viewport.name}: live trim removed or moved the reading anchor ${liveAnchorDrift}`);
      await page.locator('.message-stream').evaluate(stream => stream.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })));
      await page.getByRole('button', { name: '\u56de\u5230\u6700\u65b0\u6d88\u606f', exact: true }).click();
      await page.locator('.message-stream').getByText('Live request 19', { exact: true }).waitFor();
      await page.goto(origin);
      await page.locator('.home-view textarea').fill('Home draft survives first-send failure');
      await page.locator('.home-view .composer input[type=file]').setInputFiles({
        name: 'home-context.png', mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4xoAAAAASUVORK5CYII=', 'base64')
      });
      await page.locator('.composer-image').waitFor();
      await page.getByRole('button', { name: '\u53d1\u9001\u4efb\u52a1', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic first-send failure' }).waitFor();
      assert.equal(await page.locator('.home-view').count(), 0);
      assert.equal(await page.locator('.composer textarea').inputValue(), 'Home draft survives first-send failure');
      assert.equal(await page.locator('.composer-image').count(), 1);
      assert.equal(actions.filter(action => action.method === 'thread/start').length, 1);
      assert.equal(actions.find(action => action.method === 'turn/start')?.params.threadId, 'created');
      await page.screenshot({ path: `${output}/first-send-failure-${viewport.name}.png` });
      assert.deepEqual(errors, []);
      results.push({ viewport, realReact: true, resumeRetry: true, stackedDocks: true, explicitAnswers: true,
        answerFailureRetained: true, emptyQueueModes: true, schedulePreserved: true,
        boundedHistory: { maximumUsers, worstAnchorDrift, forwardPages, historyReads, anchorReads, liveAnchorDrift },
        homeDraftTransferred: true, errors });
    } catch (error) {
      await page.screenshot({ path: `${output}/failure-${viewport.name}.png` });
      console.error(JSON.stringify({ viewport: viewport.name, actions, errors, text: (await page.locator('body').innerText()).slice(-12000) }));
      throw error;
    } finally { await context.close(); }
  }
  await fs.writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
