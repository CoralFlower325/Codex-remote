import http from 'node:http';
import express from 'express';
import { expect, it } from 'vitest';
import { apiBoundary } from './api-boundary.js';

it('protects newly assembled private routes by default and keeps public exceptions exact', async () => {
  const app = express();
  app.use('/api', apiBoundary((req, res, next) => {
    if (req.get('cookie') === 'synthetic=valid') next();
    else res.sendStatus(401);
  }));
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const request = (pathname: string, cookie?: string) => new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as import('node:net').AddressInfo).port,
      path: pathname, headers: cookie ? { cookie } : {} }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode!));
    }).on('error', reject);
  });
  try {
    for (const route of ['/api/thread/open', '/api/local-image', '/api/attachments',
      '/api/future-sensitive-route', '/api/auth/status/extra', '/api/file-preview/render']) {
      expect(await request(route)).toBe(401);
      expect(await request(route, 'synthetic=valid')).toBe(200);
    }
    expect(await request('/api/auth/status')).toBe(200);
    expect(await request('/api/bootstrap')).toBe(200);
    expect(await request('/api/file-preview/render/synthetic/style.css')).toBe(200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
