import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ??
  '../desktop/node_modules/playwright/index.mjs');
import { compactHistoryEntries } from '../dist-server/server/history-payload.js';

// Production client with isolated synthetic native data. Never connect to Desktop.
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const directory = 'output/playwright/subagent-activity-0216';
const model = { id: 'demo', model: 'demo', displayName: 'Demo', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const thread = { id: 'main', name: 'Subagent activity acceptance', preview: 'Synthetic native events',
  cwd: '/project', model: 'demo', createdAt: 1, updatedAt: 2, status: { type: 'active', activeFlags: [] } };
const native = item => ({ turnId: 'work', item, startedAtMs: item.startedAtMs ?? null,
  completedAtMs: item.completedAtMs ?? null });
const command = id => ({ type: 'commandExecution', id, command: `echo ${id}`, cwd: '/project',
  status: 'completed', aggregatedOutput: `Synthetic output for ${id}`, exitCode: 0, durationMs: 10 });
const fileChange = id => ({ type: 'fileChange', id, status: 'completed',
  changes: [{ path: `/project/${id}.ts`, diff: '+ synthetic change' }] });
const childEvent = (id, child, kind) => ({ type: 'subAgentActivity', id, kind,
  agentThreadId: child, agentPath: `/root/${child}`, model: null, reasoningEffort: null });
const collab = (id, child, tool, status) => ({ type: 'collabAgentToolCall', id, tool,
  status: 'completed', senderThreadId: 'main', receiverThreadIds: [child], prompt: null,
  model: null, reasoningEffort: null, agentsStates: { [child]: { status, message: null } } });
const commentary = (id, text) => ({ type: 'agentMessage', id, phase: 'commentary', text });
const user = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
const send = (socket, body) => socket.readyState === 1 && socket.send(JSON.stringify(body));
let items, timing, activeTurnId, actions, detailReads;
function reset() {
  thread.status = { type: 'active', activeFlags: [] };
  timing = { id: 'work', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 125,
    completedAt: null, durationMs: null };
  activeTurnId = 'work'; actions = []; detailReads = [];
  items = [
    user('request', 'Original synthetic request'),
    commentary('intro', 'Visible progress before the child entrance.'),
    collab('spawn-one', 'child-one', 'spawnAgent', 'running'),
    command('command-one'), childEvent('child-one-start', 'child-one', 'started'),
    fileChange('edit-one'), collab('wait-one', 'child-one', 'wait', 'running'),
    command('command-two'), childEvent('child-one-done', 'child-one', 'completed')
  ].map(native);
}
function event(method, params) {
  for (const socket of sockets.clients) send(socket, { type: 'event', method, params: { threadId: 'main', ...params } });
}
function append(...next) {
  for (const item of next) {
    items.push(native(item));
    event('item/completed', { turnId: 'work', item });
  }
}
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true, setupAllowed: false }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true, workspace: {
  threads: { data: [thread], nextCursor: null }, models: { data: [model] }, projects: { data: [] } } }));
app.get('/api/threads', (_q, r) => r.json({ data: [thread], nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [{ id: ':workspace', allowed: true }], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/thread/open', (_q, r) => r.json({ result: { thread }, items: compactHistoryEntries(items),
  turns: [timing], activeTurnId, nextCursor: null, turnsCursor: null }));
app.get('/api/thread/timings', (_q, r) => r.json({ turns: [timing], activeTurnId, turnsCursor: null }));
app.get('/api/thread/item', (q, r) => {
  const item = items.find(entry => entry.turnId === q.query.turnId && entry.item.id === q.query.itemId);
  detailReads.push(q.query.itemId);
  r.json({ data: item ? [item] : [] });
});
app.get('/api/thread/dock/goal', (_q, r) => r.json({ goal: null }));
app.get('/api/thread/dock/queue', (_q, r) => r.json({ data: [], nextCursor: null }));
app.get('/api/thread/outline', (_q, r) => r.json({ turns: [], nextCursor: null }));
app.use(express.static('dist/client'));
sockets.on('connection', socket => {
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => {
    const m = JSON.parse(String(raw)), params = m.params ?? {};
    if (m.type === 'ping') return send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') {
      send(socket, { type: 'questions.snapshot', counts: {} });
      send(socket, { type: 'server.request.snapshot', requests: [] });
      return send(socket, { type: 'sync.ready', epoch: 'subagent-activity', sequence: 0, resumed: true });
    }
    if (m.type !== 'rpc') return;
    if (['turn/start', 'turn/steer', 'turn/interrupt', 'thread/start', 'thread/fork'].includes(m.method)) {
      actions.push(m.method);
      return send(socket, { type: 'rpc.error', id: m.id, error: { message: 'Model actions are disabled in this fixture.' } });
    }
    let result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result.data = params.parentThreadId ? [] : [thread];
    if (m.method === 'model/list') result.data = [model];
    if (['thread/read', 'thread/resume'].includes(m.method)) result = { thread };
    if (m.method === 'thread/turns/list') result.data = [timing];
    if (m.method === 'thread/items/list') result.data = items.filter(entry => !params.turnId || entry.turnId === params.turnId);
    send(socket, { type: 'rpc.result', id: m.id, result });
  });
});

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
    const stream = page.locator('.message-stream');
    await stream.getByText('Visible progress before the child entrance.', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled);
    const groups = stream.locator('.activity-group');
    const entrances = stream.locator('.subagent-row');
    assert.equal(await groups.count(), 1, `${size.name}: repeated child updates split initial operations`);
    assert.equal(await entrances.count(), 1);
    assert.equal(await entrances.first().locator('.subagent-status').innerText(), '\u5df2\u5b8c\u6210');
    assert.equal(detailReads.length, 0, 'Folded command bodies loaded before interaction');
    await page.screenshot({ path: `${directory}/${size.name}-initial.png` });
    await groups.first().locator('.activity-group-toggle').click();
    const expandCommands = async group => {
      for (const row of await group.locator('details.activity-row').all()) {
        const preview = row.locator('.activity-command-preview');
        if (!await preview.count()) continue;
        const name = (await preview.innerText()).replace(/^echo /, '');
        if (!await row.evaluate(node => node.open)) await row.locator('summary').click();
        await row.locator('.output-block').filter({ hasText: `Synthetic output for ${name}` }).waitFor();
      }
    };
    await expandCommands(groups.first());
    assert.deepEqual([...new Set(detailReads)].sort(), ['command-one', 'command-two']);
    await groups.first().evaluate(node => {
      window.__activityGroup = node;
      window.__activityToggle = node.querySelector('.activity-group-toggle');
      window.__commandDetails = node.querySelector('details.activity-row');
    });
    append(command('command-three'), childEvent('child-one-restart', 'child-one', 'started'),
      fileChange('edit-two'), collab('wait-two', 'child-one', 'wait', 'completed'),
      childEvent('child-one-redone', 'child-one', 'completed'));
    await groups.first().locator('.activity-command-preview').filter({ hasText: 'echo command-three' }).waitFor();
    assert.equal(await groups.count(), 1, 'Live child updates fragmented existing activity');
    const stable = await groups.first().evaluate(node => ({
      group: node === window.__activityGroup,
      toggle: node.querySelector('.activity-group-toggle') === window.__activityToggle,
      command: node.querySelector('details.activity-row') === window.__commandDetails,
      groupOpen: node.querySelector('.activity-group-toggle').getAttribute('aria-expanded') === 'true',
      commandOpen: window.__commandDetails.open
    }));
    assert.deepEqual(stable, { group: true, toggle: true, command: true, groupOpen: true, commandOpen: true });
    await expandCommands(groups.first());
    assert.equal(await groups.first().locator('.activity-command-preview').count(), 3);
    assert.equal(await groups.first().locator('.output-block').count(), 3);
    await page.screenshot({ path: `${directory}/${size.name}-live-expanded.png` });
    append(user('steer', 'Synthetic steering request'),
      commentary('after-steer', 'Visible progress after steering.'),
      collab('spawn-two', 'child-two', 'spawnAgent', 'running'),
      command('command-four'), childEvent('child-two-start', 'child-two', 'started'),
      command('command-five'), collab('wait-three', 'child-two', 'wait', 'completed'),
      command('command-six'), childEvent('child-two-done', 'child-two', 'completed'));
    await stream.getByText('Visible progress after steering.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.message-stream .activity-group').length === 2);
    assert.equal(await groups.count(), 2, 'Steering lost its independent activity boundary');
    const slices = await stream.locator('.turn-response').evaluateAll(nodes => nodes.map(node => ({
      groups: node.querySelectorAll('.activity-group').length,
      entrances: node.querySelectorAll('.subagent-row').length
    })));
    assert.deepEqual(slices, [{ groups: 1, entrances: 1 }, { groups: 1, entrances: 1 }]);
    assert.equal(await groups.first().evaluate(node => node === window.__activityGroup), true);
    assert.equal(await groups.first().locator('.activity-group-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await stream.getByText('Synthetic steering request', { exact: true }).count(), 1);
    assert.equal(await stream.getByText('Visible progress before the child entrance.', { exact: true }).count(), 1);
    await groups.last().locator('.activity-group-toggle').click();
    await expandCommands(groups.last());
    const commands = await stream.locator('.activity-command-preview').allTextContents();
    assert.deepEqual(commands, ['one', 'two', 'three', 'four', 'five', 'six'].map(id => `echo command-${id}`));
    await page.screenshot({ path: `${directory}/${size.name}-steering.png` });
    const final = { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Synthetic final answer.',
      startedAtMs: timing.startedAt * 1000 + 127250, completedAtMs: timing.startedAt * 1000 + 190000 };
    items.push(native(final));
    event('item/started', { turnId: 'work', item: final, startedAtMs: final.startedAtMs });
    timing = { ...timing, status: 'completed', completedAt: timing.startedAt + 190, durationMs: 190000 };
    activeTurnId = null; thread.status = { type: 'idle' };
    event('turn/completed', { turn: { ...timing, items: items.map(entry => entry.item) } });
    await stream.getByText('Synthetic final answer.', { exact: true }).waitFor();
    await stream.locator('.turn-disclosure').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.message-stream .activity-group').length === 0);
    assert.equal(await stream.locator('.turn-disclosure').count(), 1);
    assert.equal(await entrances.count(), 2);
    assert.equal(await stream.getByText('Original synthetic request', { exact: true }).count(), 1);
    assert.equal(await stream.getByText('Synthetic steering request', { exact: true }).count(), 1);
    assert.equal(await stream.getByText('Visible progress before the child entrance.', { exact: true }).count(), 0);
    assert.equal(await stream.getByText('Visible progress after steering.', { exact: true }).count(), 0);
    assert.equal(await stream.locator('.turn-duration').innerText(), '\u7528\u65f6 2\u5206\u949f 7\u79d2');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${directory}/${size.name}-completed.png` });
    await stream.locator('.turn-disclosure').click();
    await stream.getByText('Visible progress before the child entrance.', { exact: true }).waitFor();
    await stream.getByText('Visible progress after steering.', { exact: true }).waitFor();
    assert.equal(await groups.count(), 2);
    assert.equal(await entrances.count(), 2);
    await stream.locator('.turn-disclosure').click();
    await page.waitForFunction(() => document.querySelectorAll('.message-stream .activity-group').length === 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(actions, []);
    results.push({ viewport: size.name, initialGroups: 1, liveGroups: 1, steeringGroups: 2,
      expandedCommands: commands.length, detailsDeferredUntilExpansion: true, stable, visibleCommentary: true,
      independentSteeringSlices: slices, completedGroups: 0, completedEntrances: 2, finalVisible: true,
      sharedCompletionFold: true, horizontalOverflow: false, modelActions: actions.length, errors });
    await context.close();
  }
  await fs.writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${directory}/diagnostic.png` });
    console.log(JSON.stringify({ url: currentPage.url(), text: await currentPage.locator('body').innerText() }));
  }
  throw error;
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
