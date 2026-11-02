import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { publicClientRouter } from '../dist-server/server/public-client-router.js';

const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ??
  '../desktop/node_modules/playwright/index.mjs');
const directory = 'output/playwright/pr7-workspace-0218';
const app = express(), server = http.createServer(app), sockets = new WebSocketServer({server});
const model = {id:'demo',model:'demo',displayName:'Demo',description:'Synthetic model description',
  isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]};
const threads = ['a','b'].map(id => ({id,name:`Synthetic ${id}`,cwd:'/project',model:'demo',
  preview:'Synthetic request',createdAt:1,updatedAt:2,status:{type:'idle'},permissionProfile:':workspace'}));
const timing = {id:'t',status:'completed',startedAt:1,completedAt:2,durationMs:1000};
let authenticated = false, loginRequests = 0, actions = [];
const send = (socket, body) => socket.readyState === 1 && socket.send(JSON.stringify(body));
app.use(express.json());
app.get('/api/auth/status', (_q,r) => r.json({configured:true,authenticated,setupAllowed:false}));
app.post('/api/auth/login', (_q,r) => { loginRequests++; authenticated = true; r.json({ok:true}); });
app.get('/api/bootstrap', (_q,r) => r.json({configured:true,authenticated,...(authenticated ? {workspace:{
  threads:{data:threads,nextCursor:null},models:{data:[model]},projects:{data:[]}}}: {})}));
app.get('/api/threads', (q,r) => r.json({data:threads.filter(t => Boolean(t.archived) === (q.query.archived === 'true')),nextCursor:null}));
app.get('/api/permissions', (_q,r) => r.json({data:[{id:':workspace',allowed:true},
  {id:':read-only',allowed:true},{id:':danger-full-access',allowed:true}],defaultProfile:':workspace'}));
app.get('/api/connections', (_q,r) => r.json({publicOrigin:null,lanOrigins:[]}));
app.get('/api/thread/open', (q,r) => r.json({result:{thread:threads.find(t => t.id === q.query.threadId)},
  items:[{turnId:'t',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:`Latest ${q.query.threadId}`}}],
  turns:[timing],activeTurnId:null,nextCursor:null,turnsCursor:null}));
app.get('/api/thread/timings', (_q,r) => r.json({turns:[timing],activeTurnId:null,turnsCursor:null}));
app.get('/api/thread/outline', (_q,r) => r.json({turns:[],nextCursor:null}));
app.get('/api/thread/dock/goal', (_q,r) => r.json({goal:null}));
app.get('/api/thread/dock/queue', (_q,r) => r.json({data:[],nextCursor:null}));
app.use(publicClientRouter(path.resolve('dist/client')));
sockets.on('connection', socket => {
  send(socket,{type:'hello',connectedAt:new Date().toISOString(),codexAvailable:true});
  send(socket,{type:'bridge.status',status:'ready'});
  socket.on('message', raw => {
    const m = JSON.parse(String(raw)), p = m.params ?? {};
    if (m.type === 'ping') return send(socket,{type:'pong',at:new Date().toISOString()});
    if (m.type === 'sync.resume') return send(socket,{type:'sync.ready',epoch:'pr7',sequence:0,resumed:true});
    if (m.type !== 'rpc') return;
    let result = {data:[],nextCursor:null};
    if (m.method === 'thread/list') result.data = p.parentThreadId ? [] : threads.filter(t => !!t.archived === !!p.archived);
    if (['thread/read','thread/resume'].includes(m.method)) result = {thread:threads.find(t => t.id === p.threadId)};
    if (m.method === 'thread/turns/list') result.data = [timing];
    if (m.method === 'model/list') result.data = [model];
    if (['thread/archive','thread/unarchive'].includes(m.method)) {
      actions.push(m.method);
      threads.find(t => t.id === p.threadId).archived = m.method === 'thread/archive';
    }
    if (m.method.startsWith('turn/')) throw new Error('No model action is allowed in this fixture.');
    send(socket,{type:'rpc.result',id:m.id,result});
  });
});
await fs.mkdir(directory,{recursive:true});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel:'chrome',headless:true});
const results = [];
try {
  const context = await browser.newContext({serviceWorkers:'block'});
  const page = await context.newPage(), requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto(origin);
  await page.locator('#login-password').waitFor();
  await page.waitForTimeout(300);
  assert.equal(requests.some(url => /\/Workspace-[^/]+\.js/.test(url)),false);
  await page.getByRole('button',{name:'\u767b\u5f55',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'\u8bf7\u5148\u8f93\u5165\u8bbf\u95ee\u5bc6\u7801'}).waitFor();
  assert.equal(loginRequests,0);
  assert.equal(await page.locator('#login-password').evaluate(node => node === document.activeElement),true);
  await page.locator('#login-password').fill('synthetic');
  await page.getByRole('button',{name:'\u767b\u5f55',exact:true}).click();
  await page.locator('.app-shell').waitFor();
  assert.equal(loginRequests,1);
  assert.equal((await context.request.get(`${origin}/unknown-page`)).status(),404);
  await context.close();
  for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json','utf8'))) {
    threads.forEach(t => t.archived = false); actions = [];
    const context = await browser.newContext({viewport:{width:size.width,height:size.height},
      deviceScaleFactor:size.deviceScaleFactor,isMobile:size.mobile,hasTouch:size.mobile,serviceWorkers:'block'});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/?thread=a`);
    await page.locator('.message-stream').getByText('Latest a',{exact:true}).waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled);
    const layout = await page.locator('.app-shell').getAttribute('data-layout');
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const add = document.querySelector('.composer-add').getBoundingClientRect();
      return {bottom:shell.bottom,composerBottom:composer.bottom,add:add.width,
        overflow:document.documentElement.scrollWidth > innerWidth};
    });
    assert.equal(geometry.overflow,false);
    assert(geometry.composerBottom <= size.height + 1, JSON.stringify(geometry));
    assert(Math.abs(geometry.add - (layout === 'mobile' ? 24 : 28 * 2 / 3)) < .1);
    await page.locator('.composer textarea').fill('Synthetic retained draft');
    await page.screenshot({path:`${directory}/${size.name}.png`});
    if (layout === 'mobile') {
      await page.getByRole('button',{name:'\u6253\u5f00\u4efb\u52a1\u5217\u8868',exact:true}).click();
    }
    await page.locator('.thread-row[data-thread-id="a"]').hover();
    await page.locator('.thread-row-container').filter({has:page.locator('[data-thread-id="a"]')})
      .locator('.thread-archive').click();
    await page.locator('.archive-notice').waitFor();
    if (layout === 'mobile') await page.keyboard.press('Escape');
    await page.locator('.archive-notice').getByRole('button',{name:'\u64a4\u9500',exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('.archive-notice'));
    assert.deepEqual(actions,['thread/archive','thread/unarchive']);
    assert.deepEqual(errors,[]);
    results.push({viewport:size.name,layout,...geometry,archiveUndo:true,errors});
    await context.close();
  }
  await fs.writeFile(`${directory}/results.json`,JSON.stringify({anonymousWorkspaceDeferred:true,
    emptyPasswordFeedback:true,unknownPage404:true,viewports:results},null,2),'utf8');
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
