import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { threadDockRouter } from './thread-dock-router.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});
async function fixture(read: (method: string, params: unknown) => Promise<unknown> = async () => ({ goal: null })) {
  const native = vi.fn(read);
  const app = express();
  app.use('/dock', threadDockRouter((req, res, next) => {
    if (req.get('Cookie') !== 'session=operator') { res.status(401).end(); return; } next();
  }, native));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'Native read failed.' });
  });
  const server = http.createServer(app); servers.push(server); server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/dock`;
  // OS-assigned test ports can be on fetch's browser-reserved port list.
  const get = (path: string, auth = true) => new Promise<Response>((resolve, reject) => {
    http.get(base + path, { headers: auth ? { Cookie: 'session=operator' } : {} }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(response.headers)) {
          for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) headers.append(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers }));
      });
    }).on('error', reject);
  });
  return { native, get };
}

describe('early thread dock reads', () => {
  it('requires authentication and validates query parameters before native calls', async () => {
    const f = await fixture();
    expect((await f.get('/goal?threadId=chat', false)).status).toBe(401);
    for (const path of ['/goal', '/queue?threadId=a&threadId=b', '/other?threadId=a', '/queue?threadId=a&cursor=b&cursor=c']) {
      expect((await f.get(path)).status).toBe(400);
    }
    expect(f.native).not.toHaveBeenCalled();
  });
  it('does not wait for a resume/history request, and a slow goal does not block queue pages', async () => {
    let finishGoal!: (value: unknown) => void;
    const f = await fixture(async method => method === 'thread/goal/get'
      ? new Promise(resolve => { finishGoal = resolve; }) : { data: [{ id: 'queued' }], nextCursor: 'next' });
    const goal = f.get('/goal?threadId=chat');
    await vi.waitFor(() => expect(f.native).toHaveBeenCalledWith('thread/goal/get', { threadId: 'chat' }));
    const queue = await f.get('/queue?threadId=chat&cursor=next');
    expect(queue.status).toBe(200);
    expect(queue.headers.get('cache-control')).toBe('no-store');
    expect(await queue.json()).toEqual({ data: [{ id: 'queued' }], nextCursor: 'next' });
    expect(f.native).toHaveBeenCalledWith('thread/queue/list', { threadId: 'chat', limit: 100, cursor: 'next' });
    finishGoal({ goal: null }); expect((await goal).status).toBe(200);
    expect(f.native.mock.calls.every(([method]) => method === 'thread/goal/get' || method === 'thread/queue/list')).toBe(true);
  });
  it('surfaces native failures rather than silently hiding them', async () => {
    const f = await fixture(async () => { throw new Error('offline'); });
    expect((await f.get('/goal?threadId=chat')).status).toBe(500);
  });
});
