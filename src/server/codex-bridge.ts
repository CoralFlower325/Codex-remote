import { isAllowedRpcMethod } from '../shared/rpc-methods.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { NativeRpcError } from '../shared/native-error.js';

import type { ClientRpcMethod } from '../shared/protocol.js';
import { config } from './config.js';
import { desktopBridge } from './desktop-bridge.js';
import { validateGoalMutation } from '../shared/goal-mutations.js';

interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export { isAllowedRpcMethod } from '../shared/rpc-methods.js';

export class CodexBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private serverRequests = new Map<number | string, { method: string; params: unknown }>();
  private starting: Promise<void> | null = null;
  private status: 'starting' | 'ready' | 'restarting' | 'offline' = 'offline';
  private desktopRetry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor() {
    super();
    desktopBridge.on('event', (event) => this.emit('event', event));
    desktopBridge.on('server-request', (request) => this.emit('server-request', request));
    desktopBridge.on('resolved', (requestId) => this.emit('resolved', requestId));
    desktopBridge.on('connected', () => {
      this.setStatus('ready');
      this.emit('event', { method: 'remote/connected', params: {} });
    });
    desktopBridge.on('disconnected', () => {
      this.setStatus(this.child ? 'ready' : 'offline');
      this.retryDesktop();
    });
  }

  getTransport(): 'desktop' | 'standalone' {
    return desktopBridge.isConnected() ? 'desktop' : 'standalone';
  }

  getStatus(): 'starting' | 'ready' | 'restarting' | 'offline' {
    return this.status;
  }

  getBinary(): string {
    return config.codexBinary;
  }

  getPendingServerRequests(): Array<{ requestId: number | string; method: string; params: unknown }> {
    return [...desktopBridge.getPendingServerRequests(), ...[...this.serverRequests].map(([requestId, request]) => ({
      requestId,
      method: request.method,
      params: request.params
    }))];
  }

  shutdown(): void {
    this.stopped = true;
    if (this.desktopRetry) clearTimeout(this.desktopRetry);
    desktopBridge.shutdown();
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
  }

  async ensureStarted(): Promise<void> {
    if (await desktopBridge.connect()) return;
    this.retryDesktop();
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
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
    if (desktopBridge.isConnected()) return desktopBridge.request(method, requestParams);
    return this.sendRequest(method, requestParams);
  }

  async respondToServerRequest(requestId: number | string, result?: unknown, error?: unknown): Promise<void> {
    if (String(requestId).startsWith('desktop:')) {
      return desktopBridge.respondToServerRequest(String(requestId), result, error);
    }
    const request = this.serverRequests.get(requestId);
    if (!request) throw new Error('Approval request is no longer active.');

    if (error) {
      this.write({ id: requestId, error });
    } else {
      this.write({ id: requestId, result: result ?? {} });
    }
    this.serverRequests.delete(requestId);
  }

  private async start(): Promise<void> {
    this.setStatus('starting');
    const child = spawn(config.codexBinary, ['app-server', '--listen', 'stdio://'], {
      cwd: config.codexWorkdir,
      env: {
        ...process.env,
        CODEX_HOME: config.codexHome
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;

    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.setStatus('offline');
      this.failAll(error);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.setStatus('offline');
      this.failAll(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`));
    });
    child.stdin.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.setStatus('offline');
      this.failAll(error);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) this.emit('stderr', message);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));

    try {
      await this.sendRequest('initialize', {
        clientInfo: {
          name: 'codex_remote_ui',
          title: 'Codex Remote UI',
          version: '0.1.0'
        },
        capabilities: {
          experimentalApi: true
        }
      });
      this.write({ method: 'initialized' });
      this.setStatus('ready');
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        if (!child.killed) child.kill();
      }
      this.setStatus('offline');
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    } catch {
      return;
    }

    if ('id' in message && 'method' in message) {
      this.serverRequests.set(message.id, { method: message.method, params: message.params });
      this.emit('server-request', {
        requestId: message.id,
        method: message.method,
        params: message.params
      });
      return;
    }

    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new NativeRpcError({ ...message.error, message: message.error.message || 'Codex app-server request failed.' }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ('method' in message) {
      this.emit('event', { method: message.method, params: message.params });
    }
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 120_000);
      timeout.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  private write(message: unknown): void {
    if (!this.child || this.child.killed) throw new Error('Codex app-server is not running.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.serverRequests.clear();
  }

  private setStatus(status: 'starting' | 'ready' | 'restarting' | 'offline'): void {
    this.status = status;
    this.emit('status', status);
  }
}

export const codexBridge = new CodexBridge();
