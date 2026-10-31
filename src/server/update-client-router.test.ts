import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { updateClientRouter } from './update-client-router.js';

describe('backend public client fallback', () => {
  it('serves only public assets, rewrites module paths and authorizes the root worker scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-client-'));
    await fs.writeFile(path.join(root, 'index.html'), '<script src="/assets/index-new.js"></script><link href="/assets/main.css">');
    await fs.writeFile(path.join(root, 'sw-origin.js'), 'worker');
    const app = express(); app.use('/remote-client', updateClientRouter(root));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const html = await fetch(`${base}/remote-client/`);
      expect(html.headers.get('cache-control')).toBe('no-cache');
      expect(await html.text()).toBe('<script src="/remote-client/assets/index-new.js"></script><link href="/remote-client/assets/main.css">');
      const worker = await fetch(`${base}/remote-client/sw.js`);
      expect(worker.headers.get('service-worker-allowed')).toBe('/');
      expect(await worker.text()).toBe('worker');
      expect((await fetch(`${base}/remote-client/.env`)).status).toBe(404);
      expect((await fetch(`${base}/remote-client/api/bootstrap`)).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
