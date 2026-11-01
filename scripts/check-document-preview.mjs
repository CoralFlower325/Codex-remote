import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { chromium } from '../desktop/node_modules/playwright/index.mjs';
import { filePreviewRouter } from '../dist-server/server/file-preview.js';

// Synthetic workspace plus real document conversion. No Desktop connection.
const directory = path.resolve('output/playwright/documents-028');
await fs.mkdir(directory, { recursive: true });
const fixtures = path.join(directory, 'fixtures');
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ server });
let externalReads = 0, failure = false, documentRequests = 0;
app.get('/external', (_req, res) => { externalReads++; res.send('External content'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
execFileSync('python', ['scripts/create-preview-fixtures.py', fixtures, origin + '/external'], { stdio: 'pipe' });
const thread = { id: 'preview', name: 'Document acceptance', cwd: fixtures,
  preview: 'Synthetic files', model: 'demo', createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
const model = { id: 'demo', model: 'demo', displayName: 'Demo', isDefault: true,
  defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const files = ['report.docx', 'workbook.xlsx', 'slides.pptx', 'external.docx', 'broken.docx'];
const answer = files.map(name => `[${name}](${path.join(fixtures, name).replaceAll('\\', '/')})`).join('\n\n');
const turn = { id: 'done', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 };
const items = [{ turnId: 'done', item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text: answer } }];
app.get('/api/auth/status', (_q, r) => r.json({ configured: true, authenticated: true }));
app.get('/api/bootstrap', (_q, r) => r.json({ configured: true, authenticated: true, workspace: {
  threads: { data: [thread], nextCursor: null }, models: { data: [model] }, projects: { data: [] } } }));
app.get('/api/threads', (_q, r) => r.json({ data: [thread], nextCursor: null }));
app.get('/api/permissions', (_q, r) => r.json({ data: [], defaultProfile: ':workspace' }));
app.get('/api/connections', (_q, r) => r.json({ publicOrigin: null, lanOrigins: [] }));
app.get('/api/thread/open', (_q, r) => r.json({ result: { thread }, items, turns: [turn],
  nextCursor: null, turnsCursor: null, activeTurnId: null }));
app.get('/api/thread/timings', (_q, r) => r.json({ turns: [turn], turnsCursor: null }));
app.get('/api/thread/dock/goal', (_q, r) => r.json({ goal: null }));
app.get('/api/thread/dock/queue', (_q, r) => r.json({ data: [], nextCursor: null }));
app.get('/api/thread/outline', (_q, r) => r.json({ turns: [], nextCursor: null }));
app.use('/api/file-preview', (q, r, next) => {
  if (q.path === '/document') {
    documentRequests++;
    if (failure) return r.status(503).json({ error: '\u5408\u6210\u8f6c\u6362\u5668\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u91cd\u8bd5\u3002' });
  }
  next();
}, filePreviewRouter((_q, _r, next) => next()));
app.use(express.static('dist/client'));
const send = (socket, data) => socket.send(JSON.stringify(data));
sockets.on('connection', socket => {
  send(socket, { type: 'hello', connectedAt: new Date().toISOString(), codexAvailable: true });
  send(socket, { type: 'bridge.status', status: 'ready' });
  socket.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.type === 'ping') return send(socket, { type: 'pong', at: new Date().toISOString() });
    if (m.type === 'sync.resume') return send(socket, { type: 'sync.ready', epoch: 'preview', sequence: 0, resumed: true });
    if (m.type !== 'rpc') return;
    let result = { data: [], nextCursor: null };
    if (m.method === 'thread/list') result.data = m.params?.parentThreadId ? [] : [thread];
    if (m.method === 'model/list') result.data = [model];
    if (['thread/read', 'thread/resume'].includes(m.method)) result = { thread };
    send(socket, { type: 'rpc.result', id: m.id, result });
  });
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = await Promise.all(files.map(async name => hash(await fs.readFile(path.join(fixtures, name)))));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
let currentPage;
try {
  // All three modern Office formats and disabled external Writer links.
  for (const name of files.slice(0, 4)) {
    const response = await fetch(`${origin}/api/file-preview/document?${new URLSearchParams({ path: path.join(fixtures, name) })}`);
    assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const pdf = Buffer.from(await response.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    await fs.writeFile(path.join(directory, name + '.pdf'), pdf);
  }
  assert.equal(externalReads, 0);
  for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor, isMobile: size.mobile, hasTouch: size.mobile,
      permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    currentPage = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?thread=preview');
    const open = async name => {
      await page.locator('.message-stream').getByRole('link', { name, exact: true }).click();
      await page.locator('.pdf-preview canvas[data-rendered=true]').waitFor({ timeout: 60_000 });
    };
    await open('report.docx');
    const pdf = page.locator('.pdf-preview');
    assert.match(await pdf.locator('.pdf-toolbar').innerText(), /\/ 2/);
    await pdf.getByRole('button', { name: '\u4e0b\u4e00\u9875', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pdf-preview canvas[data-rendered=true]')?.getAttribute('aria-label')?.endsWith('2'));
    await pdf.getByRole('combobox').selectOption('1.25');
    await page.waitForFunction(() => document.querySelector('.pdf-preview canvas[data-rendered=true]'));
    await page.waitForTimeout(100);
    await pdf.getByRole('button', { name: '\u590d\u5236\u672c\u9875\u6587\u5b57', exact: true }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /PAGE TWO/);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '\u4e0b\u8f7d\u6587\u4ef6', exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'report.docx');
    assert.equal(hash(await fs.readFile(await download.path())), hashes[0]);
    const pixels = await pdf.locator('canvas').evaluate(canvas => {
      const ctx = canvas.getContext('2d'), bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < bytes.length; i += 16) if (bytes[i] < 180 && bytes[i + 3]) ink++;
      return { width: canvas.width, height: canvas.height, ink };
    });
    assert(pixels.ink > 100);
    assert(pixels.width * pixels.height <= 8_020_000);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const toolbar = await pdf.locator('.pdf-toolbar').evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return [...node.children].every(child => {
        const rect = child.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    });
    assert(toolbar, `${size.name}: PDF toolbar overflow`);
    await page.screenshot({ path: `${directory}/${size.name}.png` });
    // Refresh must remount conversion even when URL has not changed.
    failure = true;
    await page.getByRole('button', { name: '\u5237\u65b0\u9884\u89c8', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '\u5408\u6210\u8f6c\u6362\u5668' }).waitFor();
    assert(await page.getByRole('link', { name: '\u4e0b\u8f7d\u6587\u4ef6', exact: true }).isVisible());
    failure = false;
    await page.getByRole('button', { name: '\u5237\u65b0\u9884\u89c8', exact: true }).click();
    await page.locator('.pdf-preview canvas[data-rendered=true]').waitFor({ timeout: 60_000 });
    assert.equal(await pdf.getByRole('spinbutton').inputValue(), '1');
    assert.deepEqual(errors, []);
    results.push({ viewport: size.name, pages: 2, zoom: true, copy: true,
      originalDownload: true, conversionFailureAndRetry: true, pixels, errors });
    await context.close();
  }
  for (const [index, name] of files.entries()) assert.equal(hash(await fs.readFile(path.join(fixtures, name))), hashes[index]);
  const broken = await fetch(`${origin}/api/file-preview/document?${new URLSearchParams({ path: path.join(fixtures, 'broken.docx') })}`);
  assert.equal(broken.status, 422);
  const result = { results, externalReads, documentRequests, originalFilesUnchanged: true };
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${directory}/diagnostic.png` });
    console.log(await currentPage.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
