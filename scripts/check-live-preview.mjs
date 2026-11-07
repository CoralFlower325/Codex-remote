import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '../desktop/node_modules/playwright/index.mjs';
import { filePreviewRouter } from '../dist-server/server/file-preview.js';
import { OfficePreviews } from '../dist-server/server/office-preview.js';

const output = path.resolve('output/playwright/live-preview');
const directory = path.join(output, 'files');
await fs.mkdir(directory, { recursive: true });
const markdown = version => `# Live version ${version}\n\n` +
  Array.from({ length: 150 }, (_, index) => `Paragraph ${index + 1}: Stable reading **content** and a [link](./live.html).\n\n`).join('');
const html = version => '<!doctype html><html><head><title>Live</title></head><body>' +
  `<h1>HTML version ${version}</h1>` + Array.from({ length: 150 }, (_, i) => `<p>Row ${i + 1}</p>`).join('') + '</body></html>';
function pdf(version, count = 3) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < count; i++) {
    const text = `BT /F1 18 Tf 30 700 Td (Version ${version} Page ${i + 1}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}endstream`);
  }
  let data = '%PDF-1.4\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(data.length); data += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const offset = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  data += offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(data + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
}
let documentVersion = 1, metadataReads = 0, watches = 0, failNext = false, delayNext = 0;
let officeDelay = 0, conversions = 0;
const streams = new Set();
const app = express(), server = http.createServer(app);
app.use('/api/file-preview', (req, res, next) => {
  if (req.path === '/watch') {
    watches++; streams.add(res);
    res.on('close', () => { watches--; streams.delete(res); });
  }
  if (req.path === '/') {
    metadataReads++;
    if (failNext) { failNext = false; res.status(503).json({ error: 'Synthetic transient failure' }); return; }
    if (delayNext) { const delay = delayNext; delayNext = 0; setTimeout(next, delay); return; }
  }
  next();
}, filePreviewRouter((_req, _res, next) => next(), new OfficePreviews(async () => {
  const version = documentVersion;
  conversions++;
  if (officeDelay) await new Promise(resolve => setTimeout(resolve, officeDelay));
  return pdf(version);
})));
const vite = await createServer({ configFile: false, plugins: [react()],
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/',
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body><div id="root"></div><script type="module" src="/scripts/fixtures/live-preview.tsx"></script></body></html>')));
app.use(vite.middlewares);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`Synthetic live-preview fixture: ${origin}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], errors = [];
const only = process.argv.find(value => value.startsWith('--viewport='))?.slice('--viewport='.length);
async function write(name, data) { await fs.writeFile(path.join(directory, name), data); }
try {
  for (const size of JSON.parse(await fs.readFile('scripts/acceptance-viewports.json', 'utf8'))) {
    if (only && size.name !== only) continue;
    await write('live.md', markdown(1)); await write('live.html', html(1));
    await write('live.pdf', pdf(1)); await write('live.docx', Buffer.from('synthetic office'));
    await write('live.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4xoAAAAASUVORK5CYII=', 'base64'));
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor, isMobile: size.mobile, hasTouch: size.mobile });
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async text => { window.previewCopied = text; } }
    }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?${new URLSearchParams({ directory })}`);
    await page.getByRole('heading', { name: 'Live version 1', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.file-preview-body').scrollHeight > 2000);
    const body = page.locator('.file-preview-body');
    await body.evaluate(node => { node.scrollTop = 700; window.liveBody = node; window.liveFlash = false;
      window.liveObserver = new MutationObserver(() => {
        if (!document.querySelector('.file-preview-body') || document.querySelector('.file-preview-loading')) window.liveFlash = true;
      }); window.liveObserver.observe(document.querySelector('.file-preview'), { childList: true, subtree: true }); });
    const before = await body.evaluate(node => node.scrollTop);
    for (let i = 2; i <= 4; i++) {
      await write('live.md', markdown(i));
      await page.getByRole('heading', { name: `Live version ${i}`, exact: true }).waitFor();
    }
    const drift = await body.evaluate((node, top) => Math.abs(node.scrollTop - top), before);
    assert.ok(drift <= 1, `${size.name}: text drift ${drift}`);
    assert.equal(await body.evaluate(node => node === window.liveBody), true);
    assert.equal(await page.evaluate(() => window.liveFlash), false);
    await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await write('live.md', markdown(5) + '\n\n' + 'Appended tail\n\n'.repeat(30));
    await page.getByRole('heading', { name: 'Live version 5', exact: true }).waitFor();
    assert.ok(await body.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 2));
    await page.getByRole('button', { name: 'Line 40', exact: true }).click();
    await page.locator('[data-line="40"].is-selected').waitFor();
    await body.evaluate(node => { node.scrollTop = 1000; });
    await write('live.md', markdown(6));
    await page.locator('.file-source').getByText('Live version 6', { exact: false }).waitFor();
    assert.ok(await body.evaluate(node => Math.abs(node.scrollTop - 1000) <= 1));
    await page.getByRole('button', { name: 'Hide', exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 600));
    const hiddenReads = metadataReads;
    await write('live.md', markdown(7));
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(metadataReads, hiddenReads);
    const readsWhileHidden = metadataReads - hiddenReads;
    assert.equal(watches, 0);
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await page.locator('.file-source').getByText('Live version 7', { exact: false }).waitFor();
    assert.ok(await body.evaluate(node => Math.abs(node.scrollTop - 1000) <= 1));
    await fs.unlink(path.join(directory, 'live.md'));
    await page.getByRole('alert').waitFor();
    await write('live.md', markdown(8));
    await page.locator('.file-source').getByText('Live version 8', { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    failNext = true;
    await write('live.md', markdown(9));
    await page.locator('.file-source').getByText('Live version 9', { exact: false }).waitFor();
    await write('replacement.md', markdown(10));
    await fs.rename(path.join(directory, 'replacement.md'), path.join(directory, 'live.md'));
    await page.locator('.file-source').getByText('Live version 10', { exact: false }).waitFor();
    if (size.name === 'desktop-2k') {
      for (const response of streams) response.end();
      await page.getByRole('alert').waitFor();
      await write('live.md', markdown(11));
      await page.locator('.file-source').getByText('Live version 11', { exact: false }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await new Promise(resolve => setTimeout(resolve, 600));
      const backgroundReads = metadataReads;
      await write('live.md', markdown(12));
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(metadataReads, backgroundReads); assert.equal(watches, 0);
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.locator('.file-source').getByText('Live version 12', { exact: false }).waitFor();
      delayNext = 900;
      await write('live.md', markdown(13));
      const previousReads = metadataReads;
      for (let attempt = 0; attempt < 20 && metadataReads === previousReads; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await page.getByRole('button', { name: 'live.html', exact: true }).click();
    const frame = page.frameLocator('.file-preview-body iframe');
    await frame.getByRole('heading', { name: 'HTML version 1', exact: true }).waitFor();
    await frame.locator('body').evaluate(() => window.scrollTo(0, 500));
    await new Promise(resolve => setTimeout(resolve, 100));
    await write('live.html', html(2));
    await frame.getByRole('heading', { name: 'HTML version 2', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.file-preview-body iframe'));
    let htmlTop = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      htmlTop = await frame.locator('body').evaluate(() => window.scrollY);
      if (Math.abs(htmlTop - 500) <= 1) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(Math.abs(htmlTop - 500) <= 1, `HTML reading position: ${htmlTop}`);
    await page.getByRole('button', { name: 'live.pdf', exact: true }).click();
    await page.locator('canvas[data-rendered="true"]').waitFor();
    const number = page.locator('.pdf-toolbar input'), zoom = page.locator('.pdf-toolbar select');
    await number.fill('2'); await number.dispatchEvent('change');
    await zoom.selectOption('1.5');
    await page.locator('canvas[data-rendered="true"]').waitFor();
    const pixelBefore = await page.locator('canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return Array.from(data).reduce((sum, value, i) => i % 4 === 0 ? sum + value : sum, 0);
    });
    await write('live.pdf', pdf(2));
    await page.waitForFunction(before => {
      const canvas = document.querySelector('canvas');
      if (canvas?.dataset.rendered !== 'true') return false;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return Array.from(data).reduce((sum, value, i) => i % 4 === 0 ? sum + value : sum, 0) !== before;
    }, pixelBefore);
    assert.equal(await number.inputValue(), '2'); assert.equal(await zoom.inputValue(), '1.5');
    await page.getByRole('button', { name: 'Hide', exact: true }).click();
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await page.locator('canvas[data-rendered="true"]').waitFor();
    assert.equal(await number.inputValue(), '2'); assert.equal(await zoom.inputValue(), '1.5');
    await write('live.pdf', pdf(3, 1));
    await page.waitForFunction(() => document.querySelector('.pdf-toolbar input')?.value === '1');
    await page.locator('canvas[data-rendered="true"]').waitFor();
    assert.equal(await zoom.inputValue(), '1.5');
    if (size.name === 'desktop-2k' || size.name === 'iphone-1206x2622') {
      await page.getByRole('button', { name: 'live.png', exact: true }).click();
      await page.locator('.file-preview-image img').waitFor();
      const firstImage = await page.locator('.file-preview-image img').getAttribute('src');
      await fs.utimes(path.join(directory, 'live.png'), new Date(), new Date());
      await page.waitForFunction(previous => {
        const image = document.querySelector('.file-preview-image img');
        return image && image.src !== new URL(previous, location.href).href && image.complete && image.naturalWidth > 0;
      }, firstImage);
      documentVersion = 1;
      await page.getByRole('button', { name: 'live.docx', exact: true }).click();
      await page.locator('canvas[data-rendered="true"]').waitFor();
      await number.fill('2'); await number.dispatchEvent('change');
      await zoom.selectOption('1.25');
      await page.locator('canvas[data-rendered="true"]').waitFor();
      documentVersion = 2;
      const officeUrl = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter(entry => entry.name.includes('/api/file-preview/document')).at(-1)?.name);
      await write('live.docx', Buffer.from('synthetic office updated'));
      await page.waitForFunction(previous => performance.getEntriesByType('resource')
        .filter(entry => entry.name.includes('/api/file-preview/document')).at(-1)?.name !== previous, officeUrl);
      await page.locator('canvas[data-rendered="true"]').waitFor();
      assert.equal(await number.inputValue(), '2'); assert.equal(await zoom.inputValue(), '1.25');
      if (size.name === 'desktop-2k') {
        const started = conversions;
        officeDelay = 3500; documentVersion = 3;
        await write('live.docx', Buffer.from('synthetic office version 3'));
        for (let attempt = 0; attempt < 60 && conversions === started; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(conversions, started + 1);
        documentVersion = 4;
        await write('live.docx', Buffer.from('synthetic office version 4'));
        await new Promise(resolve => setTimeout(resolve, 2500));
        assert.equal(conversions, started + 1, 'Office must finish its current conversion');
        officeDelay = 0;
        for (let attempt = 0; attempt < 60 && conversions < started + 2; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(conversions, started + 2);
        let copied = '';
        for (let attempt = 0; attempt < 100; attempt++) {
          const copy = page.locator('.pdf-toolbar button').last();
          if (await copy.isEnabled()) {
            await copy.click();
            copied = await page.evaluate(() => window.previewCopied ?? '');
            if (copied.includes('Version 4 Page 2')) break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(copied.includes('Version 4 Page 2'), `Latest Office content: ${copied}`);
        assert.equal(await number.inputValue(), '2');
        assert.equal(await zoom.inputValue(), '1.25');
      }
    }
    await page.screenshot({ path: path.join(output, `${size.name}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    results.push({ viewport: size.name, drift, readsWhileHidden, passed: true });
    console.log(`${size.name}: live updates, reading position and paused subscriptions passed`);
    await context.close();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(errors, []);
  assert.ok(results.length > 0, 'Select an existing acceptance viewport');
  await fs.writeFile(path.join(output, only ? `results-${only}.json` : 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser.close();
  await vite.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
