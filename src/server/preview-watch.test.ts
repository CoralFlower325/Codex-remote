import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filePreviewRouter, readPreviewFile } from './file-preview.js';

describe('private open-file change subscriptions', () => {
  let directory: string, origin: string, server: http.Server;
  let allowed = true;
  const requests = new Set<http.ClientRequest>();
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-watch-'));
    const app = express();
    app.use(compression());
    app.use('/api/file-preview', filePreviewRouter((req, res, next) => {
      if (req.headers.cookie !== 'preview=test') { res.sendStatus(401); return; }
      next();
    }, undefined, () => allowed));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const request of requests) request.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { force: true, recursive: true });
  });
  async function watch(file: string, cookie = 'preview=test') {
    const events: { revision: string }[] = [];
    let body = '', closed = false;
    let request!: http.ClientRequest;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request = http.get(`${origin}/api/file-preview/watch?${new URLSearchParams({ path: file })}`,
        { headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' } }, resolve);
      requests.add(request);
      request.on('error', reject);
    });
    response.on('data', chunk => {
      body += String(chunk);
      let boundary: number;
      while ((boundary = body.indexOf('\n\n')) >= 0) {
        const event = body.slice(0, boundary); body = body.slice(boundary + 2);
        if (event.startsWith('data: ')) events.push(JSON.parse(event.slice(6)));
      }
    });
    response.on('end', () => { closed = true; });
    return { events, response, get closed() { return closed; },
      close() { request.destroy(); requests.delete(request); } };
  }
  it('requires login, validates absolute paths and never compresses events', async () => {
    const rejected = await watch(path.join(directory, 'private.txt'), '');
    expect(rejected.response.statusCode).toBe(401); rejected.close();
    const invalid = await watch('relative.txt');
    expect(invalid.response.statusCode).toBe(400); invalid.close();
    const stream = await watch(path.join(directory, 'private.txt'));
    try {
      await vi.waitFor(() => expect(stream.events).toEqual([{ revision: 'missing' }]));
      expect(stream.response.headers['content-encoding']).toBeUndefined();
      expect(stream.response.headers['cache-control']).toBe('no-store, no-transform');
    } finally { stream.close(); }
  });
  it('follows continuous writes and atomic replacements without sending file contents', async () => {
    const file = path.join(directory, 'live.md');
    await fs.writeFile(file, '# Private synthetic 1');
    const stream = await watch(file);
    try {
      const first = await readPreviewFile(file);
      await vi.waitFor(() => expect(stream.events.at(-1)?.revision).toBe(first.revision));
      for (let i = 2; i <= 4; i++) {
        await fs.writeFile(file, `# Private synthetic ${i}`);
        const next = await readPreviewFile(file);
        await vi.waitFor(() => expect(stream.events.at(-1)?.revision).toBe(next.revision));
      }
      const replacement = path.join(directory, 'replacement.md');
      await fs.writeFile(replacement, '# Atomic save');
      await fs.rename(replacement, file);
      const last = await readPreviewFile(file);
      await vi.waitFor(() => expect(stream.events.at(-1)?.revision).toBe(last.revision));
      expect(stream.events).toHaveLength(5);
      expect(JSON.stringify(stream.events)).not.toMatch(/Private|Atomic|live\.md/);
      expect(stream.events.every(event => Object.keys(event).join() === 'revision')).toBe(true);
    } finally { stream.close(); }
  });
  it('recovers from deletion and recreation of the same open path', async () => {
    const file = path.join(directory, 'recreated.txt');
    await fs.writeFile(file, 'first');
    const stream = await watch(file);
    try {
      await vi.waitFor(() => expect(stream.events).toHaveLength(1));
      await fs.unlink(file);
      await vi.waitFor(() => expect(stream.events.at(-1)?.revision).toBe('missing'));
      await fs.writeFile(file, 'restored');
      const restored = await readPreviewFile(file);
      await vi.waitFor(() => expect(stream.events.at(-1)?.revision).toBe(restored.revision));
    } finally { stream.close(); }
  });
  it('ends an existing stream after its owning login is revoked', async () => {
    const file = path.join(directory, 'revoked.txt');
    await fs.writeFile(file, 'synthetic');
    const stream = await watch(file);
    try {
      await vi.waitFor(() => expect(stream.events).toHaveLength(1));
      allowed = false;
      await fs.writeFile(file, 'must not be sent');
      await vi.waitFor(() => expect(stream.closed).toBe(true));
      expect(stream.events).toHaveLength(1);
    } finally { allowed = true; stream.close(); }
  });
});
