import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import express from 'express';
import { build } from 'esbuild';

const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ??
  '../desktop/node_modules/playwright/index.mjs');
const directory = 'output/playwright/desktop-side-chats-0218';
await fs.mkdir(directory, { recursive: true });
// Exercise the real hook with deferred synthetic RPCs; never attach to Desktop.
await build({ stdin: { contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSideChats } from './src/client/useSideChats';
const listeners = new Set();
const reads = new Map(), deferred = new Map(), calls = [], watches = [];
const base = id => ({ id, name: id, cwd: '/project', turns: [] });
const side = (id, text = 'A', status = 'inProgress') => ({
  ...base(id), threadSource: 'side_chat', forkedFromId: 'main', model: 'demo',
  turns: [{ id: 't', status, startedAt: 10, completedAt: status === 'completed' ? 20 : null,
    items: [{ id: 'answer', type: 'agentMessage', text }] }]
});
reads.set('side', side('side'));
const transport = {
  watch(ids, owner) { watches.push({ ids, owner }); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async rpc(method, params = {}) {
    calls.push({ method, params });
    if (method === 'thread/loaded/list') return params.cursor
      ? { data: ['side', 'normal-fork', 'child', 'remote'], nextCursor: null }
      : { data: Array.from({length: 100}, (_, i) => 'ordinary-' + i), nextCursor: 'tail' };
    if (method === 'thread/read') {
      if (params.includeTurns && deferred.has(params.threadId)) return deferred.get(params.threadId).promise;
      return { thread: reads.get(params.threadId) ?? base(params.threadId) };
    }
    if (method === 'turn/start') return { turn: { id: 'next', status: 'inProgress', startedAt: 30 } };
    return {};
  }
};
reads.set('normal-fork', { ...base('normal-fork'), ephemeral: true, forkedFromId: 'main' });
reads.set('child', { ...side('child'), parentThreadId: 'main' });
reads.set('remote', { ...side('remote'), threadSource: 'codex_remote' });
function Harness() {
  const [connected, connect] = useState(true), [main, select] = useState('main');
  const state = useSideChats(transport, connected);
  window.fixture = {
    ...state, calls, watches, main, connect, select,
    event(method, params) { for (const fn of listeners) fn(method, params); },
    side, put(thread) { reads.set(thread.id, thread); },
    defer(id) {
      let resolve; const promise = new Promise(done => { resolve = done; });
      deferred.set(id, { promise, resolve });
    },
    resolve(id, thread) { const pending = deferred.get(id); deferred.delete(id); pending.resolve({thread}); }
  };
  return <pre>{JSON.stringify(state.chats)}</pre>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, format: 'esm',
  outfile: `${directory}/hook.js` });
const app = express();
app.get('/', (_q, r) => r.send('<div id="root"></div><script type="module" src="/hook.js"></script>'));
app.use(express.static(directory));
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const chat = id => page.evaluate(id => window.fixture.chats.find(chat => chat.threadId === id), id);
const wait = fn => page.waitForFunction(fn);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await wait(() => window.fixture?.chats.length === 1);
  assert.equal((await chat('side')).items[0].text, 'A');
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.method === 'thread/loaded/list').length), 2);
  // Switching the parent while an event is queued must retain the batch and watch.
  await page.evaluate(() => {
    const f = window.fixture;
    f.event('item/agentMessage/delta', { threadId: 'side', turnId: 't', itemId: 'answer', delta: 'B' });
    f.select('another-main');
  });
  await wait(() => window.fixture.chats[0].items[0].text === 'AB');
  assert.deepEqual(await page.evaluate(() => window.fixture.watches.at(-1).ids), ['side']);
  // A read containing a buffered delta must not append that delta twice.
  await page.evaluate(() => {
    const f = window.fixture;
    f.defer('side');
    f.event('thread/started', { thread: f.side('side', 'AB') });
    f.event('item/agentMessage/delta', { threadId: 'side', turnId: 't', itemId: 'answer', delta: 'C' });
    f.resolve('side', f.side('side', 'ABC'));
  });
  await wait(() => window.fixture.chats[0].items[0].text === 'ABC');
  await page.waitForTimeout(100);
  assert.equal((await chat('side')).items[0].text, 'ABC');
  // Live completion wins over a stale in-progress response.
  await page.evaluate(() => {
    const f = window.fixture;
    f.defer('side');
    f.event('thread/started', { thread: f.side('side', 'ABC') });
    f.event('turn/completed', { threadId: 'side', turn: f.side('side', 'Final', 'completed').turns[0] });
    f.event('thread/settings/updated', { threadId: 'side', threadSettings: {
      model: 'updated', effort: 'low', activePermissionProfile: { id: ':read-only' } } });
    f.resolve('side', f.side('side', 'ABC'));
  });
  await wait(() => window.fixture.chats[0].activeTurnId === null);
  assert.equal((await chat('side')).items[0].text, 'Final');
  assert.equal((await chat('side')).model, 'updated');
  const id = (await chat('side')).id;
  await page.evaluate(id => window.fixture.send(id, [{type:'text', text:'Synthetic input'}]), id);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.method.startsWith('turn/')).at(-1).method), 'turn/start');
  // Reconnect reads a completion missed by this viewer.
  await page.evaluate(() => window.fixture.connect(false));
  await wait(() => window.fixture.chats[0].activeTurnId === 'next');
  await page.evaluate(() => {
    const f = window.fixture, native = f.side('side', 'Final', 'completed');
    native.turns.push({ id: 'next', status: 'completed', startedAt: 30, completedAt: 40, items: [] });
    f.put(native); f.connect(true);
  });
  await wait(() => window.fixture.chats[0].activeTurnId === null);
  // Two independent probes: the first success must not cancel the later one.
  await page.evaluate(() => {
    const f = window.fixture;
    f.put(f.side('probe-one'));
    f.put({ id: 'probe-two', forkedFromId: 'main', turns: [] });
    f.event('thread/started', { thread: { id: 'probe-one', forkedFromId: 'main' } });
    f.event('thread/started', { thread: { id: 'probe-two', forkedFromId: 'main' } });
  });
  await wait(() => window.fixture.chats.some(c => c.threadId === 'probe-one'));
  await page.evaluate(() => window.fixture.put(window.fixture.side('probe-two')));
  await wait(() => window.fixture.chats.some(c => c.threadId === 'probe-two'));
  // An explicit side without native parent metadata must remain unbound.
  await page.evaluate(() => {
    const f = window.fixture, unbound = { ...f.side('unbound'), forkedFromId: null };
    f.put(unbound); f.event('thread/started', {thread:unbound});
  });
  await wait(() => window.fixture.chats.some(c => c.threadId === 'unbound'));
  assert.equal((await chat('unbound')).sourceThreadId, undefined);
  // A close during a pending read cannot reopen a Desktop-managed viewer.
  await page.evaluate(() => {
    const f = window.fixture;
    f.defer('side'); f.event('thread/started', {thread:f.side('side')});
  });
  await page.evaluate(id => window.fixture.close(id), id);
  await page.evaluate(() => {
    const f = window.fixture;
    f.resolve('side', f.side('side')); f.connect(false);
  });
  await wait(() => !window.fixture.chats.some(c => c.threadId === 'side'));
  await page.evaluate(() => window.fixture.connect(true));
  await page.waitForTimeout(150);
  assert.equal(await chat('side'), undefined);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(c =>
    c.method === 'turn/interrupt' || c.method === 'thread/unsubscribe')), []);
  assert.deepEqual(errors, []);
  const result = { loadedCursor: true, rejectsOrdinaryForksAndChildren: true,
    stableMainNavigation: true, bufferedDeltaDeduplicated: true, liveCompletionWins: true,
    nativeSettings: true, disconnectedCompletion: true, nextTurnStarts: true,
    independentProbes: true, noInventedParent: true, closedViewerStaysClosed: true,
    noDesktopInterruptOrUnsubscribe: true, errors };
  await fs.writeFile(`${directory}/results.json`, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
