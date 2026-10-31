import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { NativeRpcError } from '../shared/native-error.js';

interface DebugTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface DesktopWindowStatus {
  available: boolean;
  title: string | null;
  url: string | null;
  composerFound: boolean;
  composerText: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

const DEBUG_PORT = Number.parseInt(process.env.CODEX_DESKTOP_DEBUG_PORT?.trim() || '9229', 10);
const BINDING = '__codexRemoteRelay';
const INSTALL_RELAY = `(() => {
  if (!window.electronBridge?.sendMessageFromView) return false;
  window.__codexRemotePendingRequests ??= new Map();
  if (window.__codexRemoteRelayListener) {
    window.removeEventListener('message', window.__codexRemoteRelayListener);
  }
  window.__codexRemoteRelayListener = (event) => {
    const data = event.data;
    if (!data || data.hostId !== 'local') return;
    if (data.type === 'mcp-request') {
      window.__codexRemotePendingRequests.set(data.request.id, data.request);
    }
    if (data.type === 'mcp-notification' && data.method === 'serverRequest/resolved') {
      window.__codexRemotePendingRequests.delete(data.params.requestId);
    }
    if (data.type === 'mcp-notification' ||
        data.type === 'mcp-request' ||
        (data.type === 'mcp-response' &&
         String(data.message?.id).startsWith('codex-remote:'))) {
      window.${BINDING}(JSON.stringify(data));
    }
  };
  window.addEventListener('message', window.__codexRemoteRelayListener);
  return [...window.__codexRemotePendingRequests.values()];
})()`;

export class DesktopBridge extends EventEmitter {
  private socket: WebSocket | null = null;
  private connecting: Promise<boolean> | null = null;
  private nextId = 0;
  private commands = new Map<number, Pending>();
  private requests = new Map<string, Pending>();
  private approvals = new Map<string, { method: string; params: any; nativeId: string | number }>();
  private retryAfter = 0;
  private closed = false;

  constructor(private readonly debugPort = DEBUG_PORT) {
    super();
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<boolean> {
    if (this.closed) return false;
    if (this.connecting) return this.connecting;
    if (this.isConnected()) return true;
    if (Date.now() < this.retryAfter) return false;
    this.connecting = this.open().catch(() => {
      this.socket?.close();
      this.socket = null;
      this.retryAfter = Date.now() + 3000;
      return false;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(): Promise<boolean> {
    const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, {
      signal: AbortSignal.timeout(1500)
    });
    const targets = await response.json() as DebugTarget[];
    const page = targets.find((target) => target.type === 'page' && target.url.includes('app://-/index.html'));
    if (!page) return false;
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    this.socket = socket;
    socket.on('message', (raw) => this.handleMessage(JSON.parse(String(raw))));
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const error = new Error('Codex Desktop connection closed.');
      for (const pending of [...this.commands.values(), ...this.requests.values()]) pending.reject(error);
      this.commands.clear();
      this.requests.clear();
      this.approvals.clear();
      this.emit('disconnected');
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Desktop connection timed out.')); }, 2000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    await this.call('Runtime.enable');
    await this.call('Runtime.addBinding', { name: BINDING });
    const installed = await this.evaluate(INSTALL_RELAY);
    if (!Array.isArray(installed)) throw new Error('Codex Desktop RPC bridge is unavailable.');
    for (const request of installed) this.retainApproval(request);
    this.emit('connected');
    return true;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isConnected()) throw new Error('Codex Desktop is not connected.');
    const id = `codex-remote:${randomUUID()}`;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Desktop request timed out: ${method}`));
      }, 120_000);
      this.requests.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    // Use the desktop's owning App Server for visible and background tasks alike.
    void this.evaluate(`window.electronBridge.sendMessageFromView(${JSON.stringify({
      type: 'mcp-request',
      hostId: 'local',
      request: { id, method, params },
      priority: 'interactive',
      source: 'thread'
    })})`).catch((error) => {
      this.requests.get(id)?.reject(error);
      this.requests.delete(id);
    });
    return result;
  }

  getPendingServerRequests() {
    return [...this.approvals].map(([requestId, { method, params }]) => ({ requestId, method, params }));
  }

  async respondToServerRequest(requestId: string, result?: unknown, error?: unknown): Promise<void> {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new Error('Approval request is no longer active.');
    await this.evaluate(`window.electronBridge.sendMessageFromView(${JSON.stringify({
      type: 'mcp-response',
      hostId: 'local',
      threadId: approval.params?.threadId,
      response: { id: approval.nativeId, ...(error ? { error } : { result: result ?? {} }) }
    })})`);
    this.approvals.delete(requestId);
  }

  async getStatus(): Promise<DesktopWindowStatus> {
    if (!await this.connect()) {
      return { available: false, title: null, url: null, composerFound: false, composerText: '' };
    }
    const state = await this.evaluate(`(() => {
      const composer = document.querySelector('[role="textbox"]');
      return { title: document.title, url: location.href, composerFound: Boolean(composer),
        composerText: composer?.innerText || '' };
    })()`);
    return { available: true, ...state };
  }

  shutdown(): void {
    this.closed = true;
    if (this.isConnected()) {
      void this.evaluate(`window.removeEventListener('message', window.__codexRemoteRelayListener)`)
        .finally(() => this.socket?.close()).catch(() => undefined);
    } else {
      this.socket?.close();
    }
  }

  private async evaluate(expression: string): Promise<any> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  private call(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.commands.delete(id); reject(new Error(`Desktop command timed out: ${method}`)); }, 5000);
      this.commands.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(message: any): void {
    if (message.id) {
      const pending = this.commands.get(message.id);
      this.commands.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      this.socket?.close();
      return;
    }
    if (message.method !== 'Runtime.bindingCalled' || message.params.name !== BINDING) return;
    const data = JSON.parse(message.params.payload);
    if (data.type === 'mcp-notification') {
      if (data.method === 'serverRequest/resolved') {
        const requestId = `desktop:${data.params.requestId}`;
        this.approvals.delete(requestId);
        this.emit('resolved', requestId);
      }
      this.emit('event', { method: data.method, params: data.params });
      return;
    }
    if (data.type === 'mcp-request') {
      this.retainApproval(data.request);
    } else {
      const response = data.message;
      const pending = this.requests.get(String(response.id));
      this.requests.delete(String(response.id));
      if (response.error) pending?.reject(new NativeRpcError(response.error));
      else pending?.resolve(response.result);
    }
  }

  private retainApproval(request: { id: string | number; method: string; params: unknown }): void {
    const requestId = `desktop:${request.id}`;
    this.approvals.set(requestId, { method: request.method, params: request.params, nativeId: request.id });
    this.emit('server-request', { requestId, method: request.method, params: request.params });
  }
}

export const desktopBridge = new DesktopBridge();
