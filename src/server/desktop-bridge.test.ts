import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { DesktopBridge } from './desktop-bridge.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function desktop(pendingRequests: unknown[] = []) {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}` }]));
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let client: WebSocket;
  const relay = (data: unknown) => client.send(JSON.stringify({
    method: 'Runtime.bindingCalled', params: { name: '__codexRemoteRelay', payload: JSON.stringify(data) }
  }));
  sockets.on('connection', (socket) => {
    client = socket;
    socket.on('message', (raw) => {
      const command = JSON.parse(String(raw));
      const expression = command.params?.expression ?? '';
      socket.send(JSON.stringify({ id: command.id, result: { result: {
        value: expression.includes('window.__codexRemotePendingRequests ??=') ? pendingRequests : true
      } } }));
      if (expression.startsWith('window.electronBridge.sendMessageFromView(')) {
        const message = JSON.parse(expression.slice('window.electronBridge.sendMessageFromView('.length, -1));
        if (message.type === 'mcp-request') {
          relay({ type: 'mcp-response', message: {
            id: message.request.id,
            ...(message.request.method === 'bad'
              ? { error: { message: 'Native failure', code: -32000,
                data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } } }
              : { result: { threadId: message.request.params.threadId } })
          } });
        }
      }
    });
  });
  const bridge = new DesktopBridge(port);
  cleanup.push(async () => {
    bridge.shutdown();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
  });
  return { bridge, relay };
}

describe('desktop RPC transport', () => {
  it('shares one connection for concurrent requests and propagates native errors', async () => {
    const { bridge } = await desktop();
    expect(await Promise.all([bridge.connect(), bridge.connect()])).toEqual([true, true]);
    expect(await bridge.request('thread/read', { threadId: 'other-task' })).toEqual({ threadId: 'other-task' });
    await expect(bridge.request('bad', {})).rejects.toThrow('Native failure');
    await expect(bridge.request('bad', {})).rejects.toMatchObject({
      code: -32000, data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }
    });
  });

  it('forwards live desktop notifications and retains approvals across client reconnects', async () => {
    const { bridge, relay } = await desktop();
    await bridge.connect();
    const notification = new Promise((resolve) => bridge.once('event', resolve));
    relay({ type: 'mcp-notification', method: 'item/agentMessage/delta', params: { threadId: 't', delta: 'hello' } });
    expect(await notification).toMatchObject({ method: 'item/agentMessage/delta', params: { delta: 'hello' } });
    const approval = new Promise((resolve) => bridge.once('server-request', resolve));
    relay({ type: 'mcp-request', request: { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } } });
    await approval;
    expect(bridge.getPendingServerRequests()).toHaveLength(1);
    await bridge.respondToServerRequest('desktop:7', { decision: 'accept' });
    expect(bridge.getPendingServerRequests()).toEqual([]);
  });

  it('restores pending native approvals when the relay reconnects and removes desktop decisions', async () => {
    const { bridge, relay } = await desktop([
      { id: 8, method: 'item/fileChange/requestApproval', params: { threadId: 't' } }
    ]);
    await bridge.connect();
    expect(bridge.getPendingServerRequests()).toMatchObject([{ requestId: 'desktop:8', params: { threadId: 't' } }]);
    const resolved = new Promise((resolve) => bridge.once('resolved', resolve));
    relay({ type: 'mcp-notification', method: 'serverRequest/resolved', params: { requestId: 8 } });
    expect(await resolved).toBe('desktop:8');
    expect(bridge.getPendingServerRequests()).toEqual([]);
  });
});
