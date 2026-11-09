import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { chromium } from '../desktop/node_modules/playwright/index.mjs';

// Exercise the real client with synthetic native RPC/events, never a Desktop turn.
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const model = { id: 'demo', model: 'demo', displayName: 'Demo', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const thread = { id: 'main', name: 'Skill and timing acceptance', preview: 'Synthetic messages',
  cwd: '/project', model: 'demo', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, permissionProfile: ':workspace' };
const skill = { name: 'neat-freak', path: '/skills/neat-freak/SKILL.md',
  description: 'Synthetic skill', enabled: true, interface: { displayName: 'Neat Freak' } };
const mention = '[$neat-freak](/skills/neat-freak/SKILL.md)';
const native = (turnId, item) => ({ turnId, item,
  startedAtMs: item.startedAtMs ?? null, completedAtMs: item.completedAtMs ?? null });
const send = (socket, body) => socket.readyState === 1 && socket.send(JSON.stringify(body));
const event = (method, params) => {
  for (const socket of sockets.clients) send(socket, { type: 'event', method, params: { threadId: 'main', ...params } });
};
let items, turns, activeTurnId, queue, calls;
function reset() {
  items = [native('seed', { type: 'userMessage', id: 'seed-user', content: [{ type: 'text', text: 'Seed request' }] }),
    native('seed', { type: 'agentMessage', id: 'seed-answer', phase: 'final_answer', text: 'Seed answer' })];
  turns = [{ id: 'seed', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 }];
  activeTurnId = null; queue = []; calls = [];
}
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true, setupAllowed: false }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true, workspace: {
  threads: { data: [thread], nextCursor: null }, models: { data: [model] }, projects: { data: [] } } }));
app.get('/api/threads', (_q, r) => r.json({ data: [thread], nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [{ id: ':workspace', allowed: true }], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/thread/open', (_q, r) => r.json({ result: { thread }, items, turns, activeTurnId,
  nextCursor: null, turnsCursor: null }));
app.get('/api/thread/timings', (_q, r) => r.json({ turns, activeTurnId, turnsCursor: null }));
app.get('/api/thread/dock/goal', (_q, r) => r.json({ goal: null }));
app.get('/api/thread/dock/queue', (_q, r) => r.json({ data: queue, nextCursor: null }));
app.get('/api/thread/outline', (_q, r) => r.json({ turns: [], nextCursor: null }));
app.use(express.static('dist/client'));
sockets.on('connection', socket => {
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => {
    const m = JSON.parse(String(raw)), p = m.params || {};
    if (m.type === 'ping') return send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') {
      send(socket, { type: 'questions.snapshot', counts: {} });
      send(socket, { type: 'server.request.snapshot', requests: [] });
      return send(socket, { type: 'sync.ready', epoch: 'skill-timing', sequence: 0, resumed: true });
    }
    if (m.type !== 'rpc') return;
    let result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result.data = p.parentThreadId ? [] : [thread];
    if (m.method === 'model/list') result.data = [model];
    if (m.method === 'skills/list') result.data = [{ skills: [skill], errors: [] }];
    if (['thread/read', 'thread/resume'].includes(m.method)) result = { thread };
    if (m.method === 'thread/turns/list') result.data = [...turns].reverse();
    if (m.method === 'thread/items/list') result.data = items.filter(e => !p.turnId || e.turnId === p.turnId);
    if (m.method === 'turn/start') {
      calls.push(m);
      activeTurnId = 'work';
      const timing = { id: 'work', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 125,
        completedAt: null, durationMs: null };
      turns.push(timing);
      const input = { type: 'userMessage', id: 'work-user', content: p.input, startedAtMs: timing.startedAt * 1000 };
      const intro = { type: 'agentMessage', id: 'intro', phase: 'commentary', text: 'Original process' };
      items.push(native('work', input), native('work', intro));
      result = { turn: timing };
      send(socket, { type: 'rpc.result', id: m.id, result });
      event('turn/started', { turn: { ...timing, items: [input, intro] } });
      event('item/completed', { turnId: 'work', item: input });
      event('item/completed', { turnId: 'work', item: intro });
      return;
    }
    if (m.method === 'thread/queue/add') {
      calls.push(m);
      queue.push({ id: 'queued', clientUserMessageId: p.clientUserMessageId, input: p.input });
      setTimeout(() => {
        event('thread/queue/changed', {});
        send(socket, { type: 'rpc.result', id: m.id, result: {} });
      }, 450);
      return;
    }
    if (m.method === 'thread/queue/update') {
      calls.push(m);
      queue[0].input = p.input;
      event('thread/queue/changed', {});
    }
    if (m.method === 'turn/steer') {
      calls.push(m);
      const input = { type: 'userMessage', id: `steer-${calls.length}`, content: p.input,
        startedAtMs: Date.now() };
      const progress = { type: 'agentMessage', id: `progress-${calls.length}`, phase: 'commentary',
        text: 'Process after steering' };
      items.push(native('work', input), native('work', progress));
      event('item/completed', { turnId: 'work', item: input });
      event('item/completed', { turnId: 'work', item: progress });
    }
    if (m.method === 'thread/queue/delete') { calls.push(m); queue = []; result = { deleted: true }; }
    send(socket, { type: 'rpc.result', id: m.id, result });
  });
});
const directory = 'output/playwright/skill-timing-027';
await fs.mkdir(directory, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
let currentPage;
try {
  for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
    reset();
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    currentPage = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?thread=main`);
    await page.locator('.message-stream').getByText('Seed answer', { exact: true }).waitFor();
    const input = page.locator('.composer textarea');
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled);
    const selectSkill = async () => {
      await input.fill('/neat-freak');
      await page.getByRole('option').filter({ hasText: '/neat-freak' }).click();
      await page.locator('.composer-context-chip').getByText('Neat Freak', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), '');
    };
    await selectSkill();
    await page.screenshot({ path: `${directory}/${size.name}-skill-only.png` });
    await page.locator('.composer-send').click();
    await page.locator('.message-stream').getByText('$neat-freak', { exact: true }).waitFor();
    const first = calls.find(call => call.method === 'turn/start');
    assert.deepEqual(first.params.input, [{ type: 'text', text: mention, text_elements: [] },
      { type: 'skill', name: skill.name, path: skill.path }]);
    const owner = async () => page.locator('.turn-response[data-turn-id="work"]').evaluateAll(nodes =>
      nodes.find(node => node.querySelector('.turn-duration'))?.dataset.scrollAnchor);
    // Sends render optimistically, so the user text can precede the native
    // turn projection; wait for the duration anchor before reading it.
    await page.waitForFunction(() =>
      document.querySelector('.turn-response[data-turn-id="work"] .turn-duration'));
    const firstOwner = await owner();
    assert(firstOwner);
    const workLabel = page.locator('.turn-response[data-turn-id="work"] .turn-duration');
    assert.match(await workLabel.innerText(), /\u5df2\u5904\u7406 2\u5206\u949f/);
    await selectSkill();
    await page.locator('.composer-send').click();
    await page.locator('.queued-message').waitFor();
    await page.locator('.queued-message--pending').waitFor();
    await page.screenshot({ path: `${directory}/${size.name}-queued-guide.png` });
    await page.getByRole('button', { name: '\u5f85\u53d1\u6d88\u606f\u64cd\u4f5c', exact: true }).click();
    await page.waitForTimeout(220);
    await page.screenshot({ path: `${directory}/${size.name}-queued-guide-menu.png` });
    await page.getByRole('menuitem', { name: '\u7f16\u8f91\u6d88\u606f', exact: true }).click();
    const queueEdit = page.getByRole('textbox', { name: '\u7f16\u8f91\u5f85\u53d1\u6d88\u606f', exact: true });
    assert.equal(await queueEdit.inputValue(), '');
    await page.getByRole('button', { name: '\u4fdd\u5b58\u5f85\u53d1\u6d88\u606f', exact: true }).click();
    await page.locator('.queued-steer').click();
    await page.locator('.message-stream').getByText('Process after steering', { exact: true }).waitFor();
    assert.equal(await owner(), firstOwner);
    assert.match(await workLabel.innerText(), /\u5df2\u5904\u7406 2\u5206\u949f/);
    const steer = calls.find(call => call.method === 'turn/steer');
    assert.equal(steer.params.expectedTurnId, 'work');
    assert.deepEqual(steer.params.input, first.params.input);
    assert.equal(await page.locator('.message-stream .user-message-text').filter({ hasText: '$neat-freak' }).count(), 2);
    await page.screenshot({ path: `${directory}/${size.name}-steering.png` });
    const work = turns.find(turn => turn.id === 'work');
    const final = { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Final answer',
      startedAtMs: work.startedAt * 1000 + 127250, completedAtMs: work.startedAt * 1000 + 190000 };
    items.push(native('work', final));
    event('item/started', { turnId: 'work', item: final, startedAtMs: final.startedAtMs });
    await page.waitForFunction(() => [...document.querySelectorAll('.turn-duration')].some(node =>
      node.textContent === '\u7528\u65f6 2\u5206\u949f 7\u79d2'));
    await page.waitForTimeout(1100);
    assert.equal(await workLabel.innerText(), '\u7528\u65f6 2\u5206\u949f 7\u79d2');
    work.status = 'completed'; work.completedAt = work.startedAt + 190; work.durationMs = 190000; activeTurnId = null;
    event('turn/completed', { turn: { ...work, items: items.filter(e => e.turnId === 'work').map(e => e.item) } });
    await page.locator('.turn-disclosure').waitFor();
    assert.equal(await owner(), firstOwner);
    assert.equal(await page.locator('.message-stream').getByText('Original process', { exact: true }).count(), 0);
    assert.equal(await page.locator('.message-stream').getByText('Process after steering', { exact: true }).count(), 0);
    assert.equal(await page.locator('.message-stream').getByText('Final answer', { exact: true }).count(), 1);
    assert.equal(await workLabel.innerText(), '\u7528\u65f6 2\u5206\u949f 7\u79d2');
    await page.locator('.turn-disclosure').click();
    await page.locator('.message-stream').getByText('Original process', { exact: true }).waitFor();
    await page.locator('.message-stream').getByText('Process after steering', { exact: true }).waitFor();
    await page.screenshot({ path: `${directory}/${size.name}-expanded.png` });
    await page.locator('.turn-disclosure').click();
    await page.goto(`http://127.0.0.1:${server.address().port}/?thread=main`);
    await page.locator('.message-stream').getByText('Final answer', { exact: true }).waitFor();
    assert.equal(await owner(), firstOwner);
    assert.equal(await workLabel.innerText(), '\u7528\u65f6 2\u5206\u949f 7\u79d2');
    assert.equal(await page.locator('.message-stream .user-message-text').filter({ hasText: '$neat-freak' }).count(), 2);
    assert.equal(await workLabel.count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${directory}/${size.name}-reopened.png` });
    assert.deepEqual(errors, []);
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(calls.filter(call => call.method === 'turn/steer').length, 1);
    results.push({ viewport: size.name, pureSkill: true, visibleNativeInput: true, queuedSkillEdit: true,
      steeringKeepsFirstTimer: true, nativeStartPreserved: true, finalAnchorFrozen: true,
      sharedFold: true, reopenedHistory: true, modelMutationsOnRealDesktop: 0, errors });
    await context.close();
  }
  await fs.writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${directory}/diagnostic.png` });
    console.log(JSON.stringify({ url: currentPage.url(), text: await currentPage.locator('body').innerText(),
      nativeItems: items.map(e => [e.turnId, e.item.id]), turns }));
  }
  throw error;
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
