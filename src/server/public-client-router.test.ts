import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { expect, it } from 'vitest';
import { publicClientRouter } from './public-client-router.js';

it('serves query-based task links and returns 404 for missing pages and assets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-public-routes-'));
  const server = http.createServer(express().use(publicClientRouter(directory)));
  try {
    await fs.writeFile(path.join(directory, 'index.html'), 'Public workspace', 'utf8');
    await fs.writeFile(path.join(directory, '404.html'), 'Missing page', 'utf8');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const home = await fetch(`${origin}/?thread=synthetic`);
    expect(home.status).toBe(200);
    expect(await home.text()).toBe('Public workspace');
    for (const route of ['/missing', '/assets/removed.js']) {
      const missing = await fetch(origin + route);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(await missing.text()).toBe('Missing page');
    }
    const api = await fetch(`${origin}/api/missing`);
    expect(api.status).toBe(404);
    expect(await api.text()).not.toBe('Missing page');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
