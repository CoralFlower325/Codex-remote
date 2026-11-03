import { isAllowedRpcMethod } from '../shared/rpc-methods.js';
import { EventEmitter } from 'node:events';

import type { ClientRpcMethod } from '../shared/protocol.js';
import { config } from './config.js';
import { desktopBridge } from './desktop-bridge.js';
import { validateGoalMutation } from '../shared/goal-mutations.js';

export { isAllowedRpcMethod } from '../shared/rpc-methods.js';

export class CodexBridge extends EventEmitter {
  private status: 'starting' | 'ready' | 'restarting' | 'offline' = 'offline';
  private desktopRetry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor() {
    super();
    desktopBridge.on('event', (event) => this.emit('event', event));
    desktopBridge.on('server-request', (request) => this.emit('server-request', request));
    desktopBridge.on('resolved', (requestId) => this.emit('resolved', requestId));
    desktopBridge.on('connected', () => {
      if (this.stopped) return;
      this.setStatus('ready');
      this.emit('event', { method: 'remote/connected', params: {} });
    });
    desktopBridge.on('disconnected', () => {
      if (this.stopped) return;
      this.setStatus('offline');
      this.retryDesktop();
    });
  }

  getTransport(): 'desktop' {
    return 'desktop';
  }

  getStatus(): 'starting' | 'ready' | 'restarting' | 'offline' {
    return this.status;
  }

  getBinary(): string {
    return config.codexBinary;
  }

  getPendingServerRequests(): Array<{ requestId: number | string; method: string; params: unknown }> {
    return desktopBridge.getPendingServerRequests();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.desktopRetry) clearTimeout(this.desktopRetry);
    desktopBridge.shutdown();
  }

  async ensureStarted(): Promise<void> {
    if (this.stopped) throw new Error('Remote 已停止。');
    const connected = await desktopBridge.connect();
    if (this.stopped) throw new Error('Remote 已停止。');
    if (connected) return;
    this.setStatus('offline');
    this.retryDesktop();
    throw new Error('Codex Desktop 连接不可用，请检查原桌面应用及桌面桥连接。Remote 不会启动独立 App Server。');
  }

  private retryDesktop(): void {
    if (this.stopped || this.desktopRetry) return;
    this.desktopRetry = setTimeout(() => {
      this.desktopRetry = null;
      void desktopBridge.connect().then((connected) => { if (!connected) this.retryDesktop(); });
    }, 3000);
    this.desktopRetry.unref();
  }

  async request(method: ClientRpcMethod, params: unknown): Promise<unknown> {
    if (!isAllowedRpcMethod(method)) {
      throw new Error(`Method ${method} is not allowed by this remote client.`);
    }
    validateGoalMutation(method, params);

    await this.ensureStarted();
    const requestParams = method === 'thread/start'
      ? { cwd: config.codexWorkdir, ...(params as Record<string, unknown>) }
      : params;
    return desktopBridge.request(method, requestParams);
  }

  async respondToServerRequest(requestId: number | string, result?: unknown, error?: unknown): Promise<void> {
    if (String(requestId).startsWith('desktop:')) {
      return desktopBridge.respondToServerRequest(String(requestId), result, error);
    }
    throw new Error('Approval request is no longer active.');
  }

  private setStatus(status: 'starting' | 'ready' | 'restarting' | 'offline'): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}

export const codexBridge = new CodexBridge();
