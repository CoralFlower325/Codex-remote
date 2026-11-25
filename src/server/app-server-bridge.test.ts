import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { AppServerBridge } from './app-server-bridge.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function serverHarness(requiredToken?: string) {
  const server = http.createServer();
  const sockets = new WebSocketServer({
    server,
    verifyClient: info => !requiredToken ||
      info.req.headers.authorization === `Bearer ${requiredToken}`
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  const socketPath = `tcp://127.0.0.1:${address.port}`;
  const messages: any[] = [];
  let client: import('ws').WebSocket | undefined;
  sockets.on('connection', socket => {
    client = socket;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {
          userAgent: 'synthetic', codexHome: process.cwd(), platformFamily: 'windows',
          platformOs: 'windows', appServerVersion: '0.130.0'
        } }));
      } else if (message.method === 'thread/read') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } }));
      }
    });
  });
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  return {
    socketPath,
    messages,
    notification(method: string, params: unknown) {
      client?.send(JSON.stringify({ method, params }));
    },
    request(id: string | number, method: string, params: unknown) {
      client?.send(JSON.stringify({ id, method, params }));
    }
  };
}

describe('shared App Server transport', () => {
  it('initializes over the authenticated transport and routes native messages', async () => {
    const harness = await serverHarness();
    const bridge = new AppServerBridge(() => [harness.socketPath]);
    cleanup.push(async () => bridge.shutdown());
    expect(await bridge.connect(), bridge.getLastConnectionError()?.message).toBe(true);
    expect(harness.messages[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'codex_remote' }, capabilities: { experimentalApi: true } }
    });
    await expect.poll(() => harness.messages[1]).toEqual({ method: 'initialized' });
    expect(await bridge.request('thread/read', { threadId: 'shared' })).toEqual({
      thread: { id: 'shared' }
    });
    const event = new Promise(resolve => bridge.once('event', resolve));
    harness.notification('turn/started', { threadId: 'shared' });
    await expect(event).resolves.toEqual({ method: 'turn/started', params: { threadId: 'shared' } });
  });

  it('responds to native server requests with the original JSON-RPC id', async () => {
    const harness = await serverHarness();
    const bridge = new AppServerBridge(() => [harness.socketPath]);
    cleanup.push(async () => bridge.shutdown());
    expect(await bridge.connect(), bridge.getLastConnectionError()?.message).toBe(true);
    const request = new Promise(resolve => bridge.once('server-request', resolve));
    harness.request(7, 'item/commandExecution/requestApproval', { threadId: 'shared' });
    await expect(request).resolves.toMatchObject({
      requestId: 'app-server:7',
      method: 'item/commandExecution/requestApproval'
    });
    await bridge.respondToServerRequest('app-server:7', { decision: 'accept' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(harness.messages).toContainEqual({ id: 7, result: { decision: 'accept' } });
  });

  it('loads a loopback endpoint descriptor and sends its capability token', async () => {
    const token = 'a'.repeat(64);
    const harness = await serverHarness(token);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-endpoint-'));
    const descriptor = path.join(directory, 'app-server.json');
    await fs.writeFile(descriptor, JSON.stringify({
      version: 1,
      url: harness.socketPath.replace('tcp://', 'ws://')
    }), 'utf8');
    await fs.writeFile(`${descriptor}.token`, token, 'utf8');
    const bridge = new AppServerBridge(() => [descriptor]);
    cleanup.push(async () => {
      bridge.shutdown();
      await fs.rm(directory, { recursive: true, force: true });
    });
    expect(await bridge.connect(), bridge.getLastConnectionError()?.message).toBe(true);
    expect(bridge.getEndpoint()).toContain('ws://127.0.0.1:');
    expect(await bridge.request('thread/read', { threadId: 'shared' })).toEqual({
      thread: { id: 'shared' }
    });
  });
});
