import { isAllowedRpcMethod } from '../shared/rpc-methods.js';
import { EventEmitter } from 'node:events';

import type { ClientRpcMethod } from '../shared/protocol.js';
import { config } from './config.js';
import { AppServerBridge } from './app-server-bridge.js';
import { validateGoalMutation } from '../shared/goal-mutations.js';

export { isAllowedRpcMethod } from '../shared/rpc-methods.js';

const RECONNECT_PROBE_MS = 100;
const OFFLINE_GRACE_MS = 1500;
const appServerBridge = new AppServerBridge(() => config.appServerEndpointCandidates);

export class CodexBridge extends EventEmitter {
  private status: 'starting' | 'ready' | 'restarting' | 'offline' = 'offline';
  private desktopRetry: ReturnType<typeof setTimeout> | null = null;
  private reconnectProbe: ReturnType<typeof setTimeout> | null = null;
  private offlineGrace: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor() {
    super();
    appServerBridge.on('event', (event) => this.emit('event', event));
    appServerBridge.on('server-request', (request) => this.emit('server-request', request));
    appServerBridge.on('resolved', (requestId) => this.emit('resolved', requestId));
    appServerBridge.on('connected', () => {
      if (this.stopped) return;
      this.clearRecoveryTimers();
      if (this.desktopRetry) clearTimeout(this.desktopRetry);
      this.desktopRetry = null;
      const wasReady = this.status === 'ready';
      this.setStatus('ready');
      if (!wasReady) this.emit('event', { method: 'remote/connected', params: {} });
    });
    appServerBridge.on('disconnected', () => {
      if (this.stopped) return;
      if (this.status !== 'ready' || this.offlineGrace) {
        this.markOffline();
        return;
      }
      // Desktop can replace its adapter briefly. Probe once before exposing an
      // outage so clients do not restart every catalog/history read.
      this.reconnectProbe = setTimeout(() => {
        this.reconnectProbe = null;
        void appServerBridge.connect();
      }, RECONNECT_PROBE_MS);
      this.reconnectProbe.unref();
      this.offlineGrace = setTimeout(() => {
        this.offlineGrace = null;
        this.markOffline();
      }, OFFLINE_GRACE_MS);
      this.offlineGrace.unref();
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
    return appServerBridge.getPendingServerRequests();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.desktopRetry) clearTimeout(this.desktopRetry);
    this.clearRecoveryTimers();
    appServerBridge.shutdown();
  }

  async ensureStarted(): Promise<void> {
    if (this.stopped) throw new Error('Remote 已停止。');
    const connected = await appServerBridge.connect();
    if (this.stopped) throw new Error('Remote 已停止。');
    if (connected) return;
    this.setStatus('offline');
    this.retryDesktop();
    throw new Error('Codex Desktop 的共享 App Server 未就绪，请确认桌面应用已正常启动。');
  }

  private retryDesktop(): void {
    if (this.stopped || this.desktopRetry) return;
    this.desktopRetry = setTimeout(() => {
      this.desktopRetry = null;
      void appServerBridge.connect().then((connected) => { if (!connected) this.retryDesktop(); });
    }, 3000);
    this.desktopRetry.unref();
  }

  private markOffline(): void {
    this.clearRecoveryTimers();
    this.setStatus('offline');
    this.retryDesktop();
  }

  private clearRecoveryTimers(): void {
    if (this.reconnectProbe) clearTimeout(this.reconnectProbe);
    if (this.offlineGrace) clearTimeout(this.offlineGrace);
    this.reconnectProbe = null;
    this.offlineGrace = null;
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
    return appServerBridge.request(method, requestParams);
  }

  async respondToServerRequest(requestId: number | string, result?: unknown, error?: unknown): Promise<void> {
    if (String(requestId).startsWith('app-server:') || String(requestId).startsWith('desktop:')) {
      return appServerBridge.respondToServerRequest(String(requestId), result, error);
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
