import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentAttachments, documentAttachmentRouter, MAX_DOCUMENT_BYTES } from './document-attachments.js';

const pdf = Buffer.from('%PDF-1.7\n' + 'synthetic fixture\n'.repeat(60) + '%%EOF\n');
const roots: string[] = [];
const servers: http.Server[] = [];
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-documents-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function request(server: http.Server, pathname: string, body: Buffer = pdf,
  extra: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: (server.address() as import('node:net').AddressInfo).port,
      path: pathname, method: 'POST', headers: {
        cookie: 'session=test', origin: 'https://remote.example', 'Content-Type': 'application/pdf',
        'X-Attachment-Name': encodeURIComponent('report.pdf'), ...extra
      }
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('private PDF attachment storage', () => {
  it('stores bounded PDF data under an owned directory and makes retry idempotent', async () => {
    const directory = await root(), documents = new DocumentAttachments(directory), id = randomUUID();
    const saved = await documents.upload(id, '../../report.pdf', pdf);
    expect(saved.path).toBe(path.join(directory, id, '.._.._report.pdf'));
    expect(await fs.readFile(saved.path)).toEqual(pdf);
    expect(await documents.upload(id, '../../report.pdf', pdf)).toEqual(saved);
    await expect(documents.upload(id, 'another.pdf', pdf)).rejects.toMatchObject({ status: 409 });
    await expect(documents.upload('../outside', 'report.pdf', pdf)).rejects.toMatchObject({ status: 400 });
    await expect(documents.upload(randomUUID(), 'report.html', pdf)).rejects.toMatchObject({ status: 400 });
    await expect(documents.upload(randomUUID(), 'report.pdf', Buffer.from('<html>not a PDF</html>')))
      .rejects.toMatchObject({ status: 422 });
  });

  it('keeps referenced documents and removes only expired unsent uploads', async () => {
    const directory = await root();
    let now = Date.now();
    const documents = new DocumentAttachments(directory, 1024 * 1024, () => now);
    const referenced = await documents.upload(randomUUID(), 'kept.pdf', pdf);
    const unused = await documents.upload(randomUUID(), 'unused.pdf', pdf);
    await documents.retain(referenced.id);
    await documents.retain(referenced.id);
    now += 25 * 60 * 60 * 1000;
    await expect(documents.retain(unused.id)).rejects.toMatchObject({ status: 410 });
    await documents.upload(randomUUID(), 'new.pdf', pdf);
    expect(await fs.readFile(referenced.path)).toEqual(pdf);
    expect(await fs.stat(unused.path).catch(() => null)).toBeNull();
    await documents.retain(referenced.id);
  });

  it('enforces aggregate storage limits without removing retained files', async () => {
    const directory = await root(), documents = new DocumentAttachments(directory, 6000);
    const saved = await documents.upload(randomUUID(), 'report.pdf', pdf);
    await documents.retain(saved.id);
    await expect(documents.upload(randomUUID(), 'other.pdf', pdf)).rejects.toMatchObject({ status: 507 });
    expect(await fs.readFile(saved.path)).toEqual(pdf);
  });

  it('refuses linked storage roots and linked attachment entries', async () => {
    const parent = await root(), outside = await root();
    await fs.writeFile(path.join(outside, 'untouched.txt'), 'synthetic private data', 'utf8');
    const linkedRoot = path.join(parent, 'linked');
    await fs.symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new DocumentAttachments(linkedRoot).upload(randomUUID(), 'report.pdf', pdf))
      .rejects.toMatchObject({ status: 409 });
    const managed = path.join(parent, 'managed'), id = randomUUID();
    await fs.mkdir(managed);
    await fs.symlink(outside, path.join(managed, id), process.platform === 'win32' ? 'junction' : 'dir');
    const documents = new DocumentAttachments(managed);
    await expect(documents.upload(id, 'report.pdf', pdf)).rejects.toMatchObject({ status: 409 });
    await expect(documents.retain(id)).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(outside, 'untouched.txt'), 'utf8')).toBe('synthetic private data');
    await fs.unlink(linkedRoot);
    await fs.unlink(path.join(managed, id));
  });

  it('rejects missing uploaded bytes on retry and linked metadata without touching targets', async () => {
    const directory = await root(), documents = new DocumentAttachments(directory);
    const saved = await documents.upload(randomUUID(), 'report.pdf', pdf);
    await fs.unlink(saved.path);
    await expect(documents.upload(saved.id, 'report.pdf', pdf)).rejects.toMatchObject({ status: 410 });
    const linked = await documents.upload(randomUUID(), 'linked.pdf', pdf);
    const metadata = path.join(path.dirname(linked.path), 'metadata.json');
    const outside = path.join(await root(), 'metadata.json');
    await fs.writeFile(outside, await fs.readFile(metadata));
    await fs.unlink(metadata);
    await fs.symlink(process.platform === 'win32' ? path.dirname(outside) : outside,
      metadata, process.platform === 'win32' ? 'junction' : 'file');
    await expect(documents.retain(linked.id)).rejects.toMatchObject({ status: 409 });
    await expect(documents.upload(linked.id, 'linked.pdf', pdf)).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(await fs.readFile(outside, 'utf8')).retained).toBe(false);
    await fs.unlink(metadata);
  });

  it('requires authentication and trusted origin, rejects oversized bodies and never caches uploads', async () => {
    const documents = new DocumentAttachments(await root());
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/attachments', documentAttachmentRouter((req, res, next) => {
      if (req.get('cookie') !== 'session=test') { res.status(401).json({ error: 'unauthorized' }); return; }
      next();
    }, (req, res, next) => {
      if (req.get('origin') !== 'https://remote.example') { res.status(403).json({ error: 'origin' }); return; }
      next();
    }, documents));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const id = randomUUID(), url = `/api/attachments/${id}`;
    expect((await request(server, url, pdf, { cookie: '' })).status).toBe(401);
    expect((await request(server, url, pdf, { origin: 'https://other.example' })).status).toBe(403);
    expect((await request(server, url, Buffer.from('{}'), { 'Content-Type': 'application/json' })).status).toBe(415);
    const response = await request(server, url);
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ id, name: 'report.pdf', size: pdf.length });
    expect(JSON.stringify(response.body)).not.toContain('digest');
    expect((await request(server, url)).body).toEqual(response.body);
    const retained = await request(server, url + '/retain', Buffer.from('{}'), { 'Content-Type': 'application/json' });
    expect(retained.status).toBe(200);
    expect((await request(server, `/api/attachments/${randomUUID()}`, Buffer.alloc(MAX_DOCUMENT_BYTES + 1))).status).toBe(413);
  });
});
