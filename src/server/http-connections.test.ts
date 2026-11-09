import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import compression from 'compression';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpConnections, MAX_HTTP_PEER_BUFFER, type RemotePeer } from './http-connections.js';

const servers: http.Server[] = [];
const streams: AbortController[] = [];
afterEach(async () => {
  for (const controller of streams.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function fixture(handler?: (peer: RemotePeer, raw: string) => Promise<void>) {
  const connected: RemotePeer[] = [];
  const disconnect = vi.fn();
  const message = vi.fn(handler ?? (async (peer, raw) => peer.send(raw)));
  const app = express();
  app.use(compression());
  app.use('/api/connection', (req, res, next) => {
    if (!req.get('Cookie')) { res.status(401).end(); return; }
    if (req.get('Origin') === 'https://other.test') { res.status(403).end(); return; }
    next();
  }, express.json({ limit: '100mb' }), httpConnections({
    session: req => req.get('Cookie')!,
    connect: peer => { connected.push(peer); peer.send(JSON.stringify({ type: 'hello' })); },
    disconnect, message
  }));
  const server = http.createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/connection?id=one`;
  const headers = { Cookie: 'session=operator', 'Content-Type': 'application/json' };
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(base, { headers, signal: controller.signal });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const post = (body: unknown, extra = {}) => fetch(base, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body)
  });
  return { base, headers, response, first, reader, post, controller, connected, disconnect, message };
}

describe('authenticated HTTP realtime channel', () => {
  it('flushes uncompressed events and preserves message bodies in both directions', async () => {
    const f = await fixture();
    expect(f.response.headers.get('content-type')).toContain('text/event-stream');
    expect(f.response.headers.get('content-encoding')).toBeNull();
    expect(f.response.headers.get('cache-control')).toContain('no-store');
    expect(f.first).toContain('data: {"type":"hello"}\n\n');
    const payload = { type: 'rpc', method: 'turn/start', id: 'one', params: { text: 'a\nb' } };
    expect((await f.post(payload)).status).toBe(202);
    expect(new TextDecoder().decode((await f.reader.read()).value)).toBe(`data: ${JSON.stringify(payload)}\n\n`);
    expect(f.message).toHaveBeenCalledOnce();
  });

  it('acknowledges receipt while native work is pending without blocking later pings', async () => {
    let finish: () => void = () => {};
    const f = await fixture(async (peer, raw) => {
      if (JSON.parse(raw).type === 'rpc') {
        await new Promise<void>(resolve => { finish = resolve; });
        peer.send('{"type":"rpc.result","id":"one","result":{}}');
      } else peer.send('{"type":"pong"}');
    });
    expect((await f.post({ type: 'rpc', id: 'one' })).status).toBe(202);
    expect((await f.post({ type: 'ping' })).status).toBe(202);
    expect(new TextDecoder().decode((await f.reader.read()).value)).toContain('"pong"');
    finish();
    expect(new TextDecoder().decode((await f.reader.read()).value)).toContain('"rpc.result"');
    expect(f.message).toHaveBeenCalledTimes(2);
  });

  it('requires the same authenticated session and rejects stale connections', async () => {
    const f = await fixture();
    expect((await fetch(f.base)).status).toBe(401);
    expect((await f.post({ type: 'ping' }, { Cookie: 'session=other' })).status).toBe(409);
    expect((await f.post({ type: 'ping' }, { Origin: 'https://other.test' })).status).toBe(403);
    expect(f.message).not.toHaveBeenCalled();
    f.connected[0]!.close();
    expect((await f.post({ type: 'ping' })).status).toBe(409);
    expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it('accepts image-sized input and releases its watcher on stream loss', async () => {
    const f = await fixture(async () => {});
    expect((await f.post({ type: 'rpc', params: { image: 'x'.repeat(1100 * 1024) } })).status).toBe(202);
    expect(f.message).toHaveBeenCalledOnce();
    f.controller.abort();
    await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledOnce());
  });

  it('closes an SSE peer before its bounded buffer can grow without limit', async () => {
    const f = await fixture();
    f.connected[0]!.send('x'.repeat(MAX_HTTP_PEER_BUFFER + 1));
    await expect(f.reader.read()).resolves.toMatchObject({ done: true });
    expect(f.disconnect).toHaveBeenCalledOnce();
  });
});
