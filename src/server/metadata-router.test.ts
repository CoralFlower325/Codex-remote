import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metadataRouter } from './metadata-router.js';
import { MetadataReader } from './bootstrap.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function fixture(native = vi.fn(async () => ({ data: [] as unknown[] }))) {
  const reader = new MetadataReader(native);
  const app = express();
  app.use('/api/metadata', metadataRouter((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.get('Cookie') !== 'session=operator') { res.status(401).end(); return; }
    next();
  }, reader.read, reader.clear));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'Native read failed.' });
  });
  const server = http.createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/metadata`;
  return {
    native, reader,
    get: (query: string, authenticated = true) => fetch(`${base}?${query}`, {
      headers: authenticated ? { Cookie: 'session=operator' } : {}
    })
  };
}

describe('independent authenticated workspace metadata', () => {
  it('requires authentication and rejects unsupported catalogs before native reads', async () => {
    const f = await fixture();
    expect((await f.get('kind=projects', false)).status).toBe(401);
    for (const query of ['', 'kind=other', 'kind=projects&kind=models']) {
      const response = await f.get(query);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.native).not.toHaveBeenCalled();
  });

  it('returns atomic complete catalog snapshots and supports explicit refreshes', async () => {
    const native = vi.fn(async (_method: string, params: unknown) =>
      (params as { cursor?: string }).cursor
        ? { data: [{ id: 'second' }], nextCursor: null }
        : { data: [{ id: 'first' }], nextCursor: 'page-2' });
    const f = await fixture(native);
    for (const kind of ['projects', 'models']) {
      const response = await f.get(`kind=${kind}&limit=999&method=thread/list`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        data: [{ id: 'first' }, { id: 'second' }],
        nextCursor: null,
        complete: true
      });
    }
    expect(f.native.mock.calls).toContainEqual(['project/list', { limit: 200 }]);
    expect(f.native.mock.calls).toContainEqual(['project/list', { limit: 200, cursor: 'page-2' }]);
    expect(f.native.mock.calls).toContainEqual(['model/list', { limit: 100, includeHidden: false }]);
  });

  it('does not let one slow catalog block the other and retries a failed native read', async () => {
    let finish!: (value: { data: unknown[] }) => void;
    const native = vi.fn(async () => ({ data: [] as unknown[] }))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('Catalog unavailable'));
    const f = await fixture(native);
    const projects = f.get('kind=projects');
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
    expect((await f.get('kind=models')).status).toBe(500);
    const retry = await f.get('kind=models');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ data: [], nextCursor: null, complete: true });
    finish({ data: [{ id: 'project' }] });
    const response = await projects;
    expect(await response.json()).toMatchObject({ data: [{ id: 'project' }], nextCursor: null, complete: true });
    expect(native).toHaveBeenCalledTimes(3);
  });
});
