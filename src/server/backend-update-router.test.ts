import http from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendUpdateRouter } from './backend-update-router.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});
async function fixture() {
  const updater = {
    status: vi.fn(async () => ({ currentVersion: '0.2.5', platform: 'win32', arch: 'x64', supported: true, operation: null })),
    check: vi.fn(async () => ({ currentVersion: '0.2.5', platform: 'win32', arch: 'x64', supported: true,
      operation: null, available: true, latestVersion: '0.2.6' })),
    start: vi.fn(async () => ({ id: crypto.randomUUID(), version: '0.2.6', fromVersion: '0.2.5',
      status: 'running' as const, updatedAt: Date.now(), progress: null }))
  };
  const app = express(); app.use(express.json());
  app.use('/api/remote-update', backendUpdateRouter((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.get('cookie') !== 'operator=true') { res.status(401).end(); return; } next();
  }, (req, res, next) => {
    if (req.get('origin') !== 'https://remote.example' || !req.is('application/json')) { res.status(403).end(); return; } next();
  }, async () => updater));
  const server = http.createServer(app); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/remote-update`;
  return { updater, get: () => fetch(base, { headers: { Cookie: 'operator=true' } }),
    post: (suffix: string, body: unknown, authenticated = true, origin = 'https://remote.example') => fetch(`${base}/${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
        ...(authenticated ? { Cookie: 'operator=true' } : {}) }, body: JSON.stringify(body)
    }) };
}
describe('authenticated remote update routes', () => {
  it('requires authentication and trusted origin before any update check or action', async () => {
    const f = await fixture();
    expect((await f.post('check', {}, false)).status).toBe(401);
    expect((await f.post('check', {}, true, 'https://attacker.example')).status).toBe(403);
    expect(f.updater.check).not.toHaveBeenCalled();
    const response = await f.get();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).currentVersion).toBe('0.2.5');
  });
  it('accepts only version, checked token and idempotency ID, never arbitrary paths or commands', async () => {
    const f = await fixture();
    for (const body of [{}, { id: '../outside' }, { id: crypto.randomUUID(), token: crypto.randomUUID(), version: 'main' }]) {
      expect((await f.post('install', body)).status).toBe(400);
    }
    expect(f.updater.start).not.toHaveBeenCalled();
    const request = { id: crypto.randomUUID(), token: crypto.randomUUID(), version: '0.2.6' };
    expect((await f.post('install', { ...request, root: '/outside', url: 'https://attacker.example', command: 'arbitrary' })).status).toBe(202);
    expect(f.updater.start).toHaveBeenCalledExactlyOnceWith(request);
  });
});
