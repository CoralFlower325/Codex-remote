import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { chromium } from '../desktop/node_modules/playwright/index.mjs';

// Isolated synthetic backend: never attach this acceptance run to Desktop.
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
const model = { id: 'demo', model: 'demo', displayName: 'Codex Demo', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
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
let submissions = [], pendingSend = null, historyReads = 0;
let syncEnabled = true, socketAttempts = 0;
const httpPeers = new Map();
const event = (method, params) => {
  for (const socket of sockets.clients) send(socket, { type: 'event', method, params: { threadId: 'a', ...params } });
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
    if (m.method === 'skills/list') result = { data: [], errors: [] };
    if (m.method === 'turn/start') {
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
const directory = 'output/playwright/composer-025';
await fs.mkdir(directory, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
    submissions = []; pendingSend = null; historyReads = 0; syncEnabled = true;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/?thread=a`);
    const input = page.locator('.composer textarea');
    await page.locator('.message-stream').getByText('A short final reply.', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled);
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
    const anchorBefore = await page.locator('[data-user-key]').last().evaluate(e => e.getBoundingClientRect().top);
    await page.mouse.wheel(0, -180);
    try {
      await page.locator('.message-stream').getByText('Earlier answer paragraph 1.', { exact: true }).waitFor({ state: 'attached', timeout: 5000 });
    } catch (error) {
      console.log(JSON.stringify({ viewport: size.name, historyReads, errors,
        text: await stream.innerText(), state: await stream.evaluate(e => ({ top:e.scrollTop, height:e.clientHeight, scroll:e.scrollHeight })) }));
      await page.screenshot({ path: `${directory}/history-diagnostic.png` });
      throw error;
    }
    const tailBefore = await page.locator('.message-stream-inner').evaluate(e => parseFloat(e.style.getPropertyValue('--reading-tail')) || 0);
    const anchorAfter = await page.locator('[data-user-key]').last().evaluate(e => e.getBoundingClientRect().top);
    assert(Math.abs(anchorAfter - anchorBefore) < 2, `History anchor moved: ${anchorBefore} -> ${anchorAfter}`);
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
    await page.locator('.composer input[type=file]').setInputFiles(Array.from({ length: 5 }, (_, i) => ({
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
    assert.equal(await page.evaluate(() => Object.values(sessionStorage).some(v => /data:image/.test(v))), false);
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
    assert.deepEqual(errors, []);
    results.push({ viewport: size.name, tailBefore, anchorDrift: anchorAfter - anchorBefore, ...layout, pasteSwitch: true, imagePreview: true,
      fileSelection: true, sendWhileSwitching: true, failedSendRetained: true, removalRetained: true,
      nativeRetry: true, nativeFailure: true, errorStyle, bannerStyle, manualReconnect: true, noActionReplay: true, errors });
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
