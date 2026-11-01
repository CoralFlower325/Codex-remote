import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filePreviewRouter, readPreviewFile } from './file-preview.js';
import { OfficePreviews, OfficePreviewError } from './office-preview.js';

// Use Node's HTTP client: an OS-assigned test port can be on Fetch's blocked-port list.
function request(url: string | URL, options: { headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    http.get(url, options, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 500,
        headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      })));
      response.on('error', reject);
    }).on('error', reject);
  });
}

describe('authenticated local previews', () => {
  let directory: string;
  let server: http.Server;
  let origin: string;
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preview-'));
    await fs.writeFile(path.join(directory, 'report.md'), '# Result\n\n[State](./status.json)', 'utf8');
    await fs.writeFile(path.join(directory, 'status.json'), '{"ready":true}', 'utf8');
    await fs.writeFile(path.join(directory, 'page.html'), '<!doctype html><h1>Preview</h1>', 'utf8');
    await fs.writeFile(path.join(directory, 'large.txt'), 'x'.repeat(1024 * 1024 + 10), 'utf8');
    await fs.writeFile(path.join(directory, 'document.docx'), Buffer.from([80, 75, 0, 3]));
    const app = express();
    app.use('/api/file-preview', filePreviewRouter((req, res, next) => {
      if (req.get('cookie') !== 'preview=test') { res.sendStatus(401); return; }
      next();
    }, new OfficePreviews(async source => {
      if (source.endsWith('encrypted.docx')) throw new OfficePreviewError('Synthetic encrypted file', 422);
      return Buffer.from('%PDF-synthetic');
    })));
    await fs.writeFile(path.join(directory, 'encrypted.docx'), 'encrypted fixture');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('reads bounded text and distinguishes renderable documents from binary downloads', async () => {
    expect(await readPreviewFile(path.join(directory, 'report.md'))).toMatchObject({ kind: 'markdown', truncated: false });
    expect(await readPreviewFile(path.join(directory, 'large.txt'))).toMatchObject({ kind: 'text', truncated: true });
    expect(await readPreviewFile(path.join(directory, 'document.docx'))).toMatchObject({ kind: 'office',
      previewUrl: expect.stringContaining('/api/file-preview/document?') });
  });
  it('requires authentication for converted documents and preserves private response/error boundaries', async () => {
    const file = await readPreviewFile(path.join(directory, 'document.docx'));
    expect((await request(origin + file.previewUrl)).status).toBe(401);
    const response = await request(origin + file.previewUrl, { headers: { cookie: 'preview=test' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/pdf');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toBe('%PDF-synthetic');
    const encrypted = await readPreviewFile(path.join(directory, 'encrypted.docx'));
    const error = await request(origin + encrypted.previewUrl, { headers: { cookie: 'preview=test' } });
    expect(error.status).toBe(422);
    expect(await error.json()).toEqual({ error: 'Synthetic encrypted file' });
  });
  it('requires authentication for metadata and raw content', async () => {
    const result = await readPreviewFile(path.join(directory, 'page.html'));
    expect((await request(`${origin}/api/file-preview?path=${encodeURIComponent(result.path)}`)).status).toBe(401);
    expect((await request(origin + result.contentUrl)).status).toBe(401);
    const response = await request(origin + result.contentUrl, { headers: { cookie: 'preview=test' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Preview</h1>');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  });
  it('keeps raw URLs usable for relative HTML assets and reports missing files', async () => {
    const result = await readPreviewFile(path.join(directory, 'page.html'));
    const url = new URL('./status.json', origin + result.contentUrl);
    const response = await request(url, { headers: { cookie: 'preview=test' } });
    expect(await response.json()).toEqual({ ready: true });
    expect((await request(`${origin}/api/file-preview?path=${encodeURIComponent(path.join(directory, 'missing.md'))}`,
      { headers: { cookie: 'preview=test' } })).status).toBe(404);
  });
  it('gives isolated HTML short-lived directory access without granting access to Remote APIs', async () => {
    const response = await request(`${origin}/api/file-preview?path=${encodeURIComponent(path.join(directory, 'page.html'))}`,
      { headers: { cookie: 'preview=test' } });
    const file = await response.json();
    const asset = await request(new URL('./status.json', origin + file.previewUrl));
    expect(await asset.json()).toEqual({ ready: true });
    expect(asset.headers.get('access-control-allow-origin')).toBe('null');
    expect((await request(origin + file.previewUrl)).status).toBe(200);
    const escape = file.previewUrl.replace(/[^/]+$/, '..%2Foutside.txt');
    expect((await request(origin + escape)).status).toBe(403);
    expect((await request(`${origin}/api/file-preview/render/unknown/status.json`)).status).toBe(401);
    expect((await request(`${origin}/api/file-preview?path=${encodeURIComponent(path.join(directory, 'status.json'))}`)).status).toBe(401);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    try { expect((await request(origin + file.previewUrl)).status).toBe(401); }
    finally { clock.mockRestore(); }
  });
  it('rejects an HTML grant crossing a directory symlink or junction', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-outside-'));
    const link = path.join(directory, 'outside');
    try {
      await fs.writeFile(path.join(outside, 'private.txt'), 'synthetic private fixture');
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const response = await request(`${origin}/api/file-preview?path=${encodeURIComponent(path.join(directory, 'page.html'))}`,
        { headers: { cookie: 'preview=test' } });
      const file = await response.json();
      const resource = new URL('./outside/private.txt', origin + file.previewUrl);
      expect((await request(resource)).status).toBe(403);
    } finally {
      await fs.unlink(link).catch(() => {});
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
