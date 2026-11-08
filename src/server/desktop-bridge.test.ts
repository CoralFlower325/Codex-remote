import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { DesktopBridge } from './desktop-bridge.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => '/* native automation relay fixture */')
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function desktop(pendingRequests: unknown[] = [],
  automationReply?: (socket: WebSocket, command: any) => void,
  options: { commandTimeoutMs?: number; responseTimeoutMs?: number; hangRequests?: number;
    ignoreNativeResponses?: boolean; additionalPorts?: number[] } = {}) {
  const commands: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/overlay') { res.writeHead(500); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([
      { type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/overlay` },
      { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}` }
    ]));
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let client: WebSocket;
  let connected = false;
  let remainingHangs = options.hangRequests ?? 0;
  const relay = (data: unknown) => client.send(JSON.stringify({
    method: 'Runtime.bindingCalled', params: { name: '__codexRemoteRelay', payload: JSON.stringify(data) }
  }));
  sockets.on('connection', (socket) => {
    client = socket;
    socket.on('message', (raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      const expression = command.params?.expression ?? '';
      if (connected && remainingHangs > 0 && expression.startsWith('window.electronBridge.sendMessageFromView(')) {
        remainingHangs--;
        return;
      }
      if (expression.includes('window.__codexRemoteAutomationRequest(') && automationReply) {
        automationReply(socket, command); return;
      }
      socket.send(JSON.stringify({ id: command.id, result: { result: {
        value: expression.includes('window.__codexRemotePendingRequests ??=') ? pendingRequests : true
      } } }));
      if (expression.includes('window.__codexRemotePendingRequests ??=')) connected = true;
      if (expression.startsWith('window.electronBridge.sendMessageFromView(')) {
        const message = JSON.parse(expression.slice('window.electronBridge.sendMessageFromView('.length, -1));
        if (message.type === 'mcp-request' && !options.ignoreNativeResponses) {
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
  const bridge = new DesktopBridge([...(options.additionalPorts ?? []), port],
    options.commandTimeoutMs, options.responseTimeoutMs);
  cleanup.push(async () => {
    bridge.shutdown();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
  });
  return { bridge, relay, commands, raw: (data: string) => client.send(data) };
}

describe('desktop RPC transport', () => {
  it('falls back to the standard debug port when the configured port is stale', async () => {
    const { bridge } = await desktop([], undefined, { additionalPorts: [1] });
    expect(await bridge.connect()).toBe(true);
  });

  it('reconnects after an OPEN DevTools socket stops answering commands', async () => {
    const { bridge } = await desktop([], undefined, { commandTimeoutMs: 100, hangRequests: 1 });
    expect(await bridge.connect()).toBe(true);
    await expect(bridge.request('thread/read', { threadId: 'stale' }))
      .rejects.toThrow('Desktop command timed out: Runtime.evaluate');
    expect(bridge.isConnected()).toBe(false);
    expect(await bridge.connect()).toBe(true);
    expect(await bridge.request('thread/read', { threadId: 'recovered' })).toEqual({ threadId: 'recovered' });
    expect(bridge.isConnected()).toBe(true);
  });

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

  it.each(['{', 'null', JSON.stringify({ method: 'Runtime.bindingCalled' }),
    JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: '__codexRemoteRelay', payload: 'null' } })])(
    'disconnects malformed relay frames safely and allows a fresh connection: %s', async frame => {
      const { bridge, raw } = await desktop();
      await bridge.connect();
      raw(frame);
      await vi.waitFor(() => expect(bridge.isConnected()).toBe(false));
      expect(await bridge.connect()).toBe(true);
      expect(await bridge.request('thread/read', { threadId: 'recovered' })).toEqual({ threadId: 'recovered' });
    });

  it('claims approvals before yielding so concurrent viewers submit only one native response', async () => {
    const { bridge, commands } = await desktop([
      { id: 9, method: 'item/fileChange/requestApproval', params: { threadId: 't' } }
    ]);
    await bridge.connect();
    const results = await Promise.allSettled([
      bridge.respondToServerRequest('desktop:9', { decision: 'accept' }),
      bridge.respondToServerRequest('desktop:9', { decision: 'accept' })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(commands.filter(command => command.params?.expression?.includes('"type":"mcp-response"'))).toHaveLength(1);
  });

  it('does not repeat an approval whose acknowledgement was lost after reconnect', async () => {
    const { bridge, commands } = await desktop([
      { id: 10, method: 'item/fileChange/requestApproval', params: { threadId: 't' } }
    ], undefined, { commandTimeoutMs: 50, hangRequests: 1 });
    await bridge.connect();
    await expect(bridge.respondToServerRequest('desktop:10', {})).rejects.toThrow();
    expect(await bridge.connect()).toBe(true);
    await expect(bridge.respondToServerRequest('desktop:10', {})).rejects.toThrow();
    expect(commands.filter(command => command.params?.expression?.includes('"type":"mcp-response"'))).toHaveLength(1);
  });

  it('bounds native response waits and reports an uncertain write without replaying it', async () => {
    const { bridge, commands } = await desktop([], undefined,
      { responseTimeoutMs: 40, ignoreNativeResponses: true });
    await bridge.connect();
    await expect(bridge.request('turn/start', { threadId: 't' })).rejects.toThrow();
    expect(bridge.isConnected()).toBe(false);
    expect(commands.filter(command => command.params?.expression?.includes('"method":"turn/start"'))).toHaveLength(1);
  });

  it('uses the native automation relay and returns unsupported-service errors without fallback', async () => {
    const { bridge, commands } = await desktop([], (socket, command) => socket.send(JSON.stringify({
      id: command.id, result: { result: { value: { ok: false, error: 'Native service unavailable' } } }
    })));
    await bridge.connect();
    await expect(bridge.requestAutomation('list')).rejects.toThrow('Native service unavailable');
    expect(commands.filter(c => c.params?.expression?.includes('window.__codexRemoteAutomationRequest('))).toHaveLength(1);
    expect(commands.some(c => c.params?.expression?.startsWith('window.electronBridge.sendMessageFromView('))).toBe(false);
  });

  it('reports an uncertain write once when the Desktop connection closes', async () => {
    const { bridge, commands } = await desktop([], socket => socket.close());
    await bridge.connect();
    await expect(bridge.requestAutomation('runNow', { id: 'native-1' })).rejects.toThrow('操作结果无法确认');
    expect(commands.filter(c => c.params?.expression?.includes('window.__codexRemoteAutomationRequest('))).toHaveLength(1);
  });
});
