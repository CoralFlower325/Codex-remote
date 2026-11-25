import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

import { NativeRpcError } from '../shared/native-error.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const REMOTE_VERSION = process.env.CODEX_REMOTE_VERSION?.trim() || '0.3.0';

interface EndpointTarget {
  label: string;
  url: string;
  headers?: Record<string, string>;
  createConnection?: () => net.Socket;
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageId(value: unknown): value is string | number {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ||
    typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Connects to the App Server owned by the Desktop CLI adapter.
 *
 * The Windows adapter publishes an authenticated loopback WebSocket, not a
 * browser debug port. The App Server accepts multiple clients and broadcasts
 * native notifications to every initialized connection.
 */
export class AppServerBridge extends EventEmitter {
  private socket: WebSocket | null = null;
  private connecting: Promise<boolean> | null = null;
  private nextId = 0;
  private pending = new Map<string | number, Pending>();
  private serverRequests = new Map<string, ServerRequest>();
  private retryAfter = 0;
  private closed = false;
  private activeEndpoint: string | null = null;
  private lastConnectionError: Error | null = null;

  constructor(
    private readonly endpointCandidates: () => string[],
    private readonly connectTimeoutMs = 2500
  ) {
    super();
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  getEndpoint(): string | null {
    return this.activeEndpoint;
  }

  getLastConnectionError(): Error | null {
    return this.lastConnectionError;
  }

  getPendingServerRequests(): Array<{ requestId: string; method: string; params: unknown }> {
    return [...this.serverRequests.entries()].map(([requestId, request]) => ({
      requestId,
      method: request.method,
      params: request.params
    }));
  }

  async connect(): Promise<boolean> {
    if (this.closed) return false;
    if (this.connecting) return this.connecting;
    if (this.isConnected()) return true;
    if (Date.now() < this.retryAfter) return false;
    this.connecting = this.open().catch((error) => {
      const socket = this.socket;
      if (socket) this.disconnectSocket(socket, error instanceof Error ? error : new Error(String(error)));
      this.retryAfter = Date.now() + 1000;
      return false;
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isConnected()) throw new Error('Codex App Server 未连接。');
    const id = `codex-remote:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async respondToServerRequest(requestId: string, result?: unknown, error?: unknown): Promise<void> {
    const pending = this.serverRequests.get(requestId);
    if (!pending) throw new Error('Approval request is no longer active.');
    if (!this.isConnected()) throw new Error('Codex App Server 未连接。');
    this.send(error === undefined
      ? { id: pending.id, result: result ?? {} }
      : {
          id: pending.id,
          error: record(error)
            ? error
            : { code: -32603, message: typeof error === 'string' ? error : 'Request failed.' }
        });
    this.serverRequests.delete(requestId);
  }

  shutdown(): void {
    this.closed = true;
    const socket = this.socket;
    if (socket) this.disconnectSocket(socket, new Error('Codex Remote stopped.'));
  }

  private async open(): Promise<boolean> {
    let lastError: Error | null = null;
    for (const candidate of this.endpointCandidates()) {
      try {
        const target = await this.resolveTarget(candidate);
        await this.openSocket(target);
        this.lastConnectionError = null;
        this.activeEndpoint = target.url;
        this.retryAfter = 0;
        this.emit('connected');
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.lastConnectionError = lastError;
      }
    }
    throw lastError ?? new Error('Codex App Server endpoint is unavailable.');
  }

  private async resolveTarget(candidate: string): Promise<EndpointTarget> {
    if (candidate.startsWith('tcp://')) {
      const target = new URL(candidate);
      return {
        label: candidate,
        url: 'ws://localhost/rpc',
        createConnection: () => net.createConnection({
          host: target.hostname,
          port: Number(target.port)
        })
      };
    }
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch {
      throw new Error('Codex App Server endpoint descriptor is unavailable.');
    }
    if (!record(descriptor)) throw new Error('Codex App Server endpoint descriptor is invalid.');
    const value = descriptor;
    if (value.version !== 1 || typeof value.url !== 'string') {
      throw new Error('Codex App Server endpoint descriptor is invalid.');
    }
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw new Error('Codex App Server endpoint URL is invalid.');
    }
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('Codex App Server endpoint must be an authenticated loopback WebSocket.');
    }
    let token: string;
    try {
      token = (await fs.readFile(`${candidate}.token`, 'utf8')).trim();
    } catch {
      throw new Error('Codex App Server capability token is unavailable.');
    }
    if (token.length < 32 || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error('Codex App Server capability token is invalid.');
    }
    return {
      label: url.origin,
      url: url.href,
      headers: { Authorization: `Bearer ${token}` }
    };
  }

  private async openSocket(target: EndpointTarget): Promise<void> {
    const socket = new WebSocket(target.url, {
      headers: target.headers,
      createConnection: target.createConnection,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false
    });
    this.socket = socket;
    socket.on('message', (raw) => {
      if (this.socket !== socket) return;
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch (error) {
        this.disconnectSocket(socket, error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.disconnectSocket(socket, error);
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.disconnectSocket(socket, new Error('Codex App Server connection closed.'));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Codex App Server connection timed out.'));
      }, this.connectTimeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const initialized = await this.call('initialize', {
      clientInfo: {
        name: 'codex_remote',
        title: 'Codex Remote',
        version: REMOTE_VERSION
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['turn/diff/updated']
      }
    });
    if (!record(initialized)) throw new Error('Codex App Server initialization failed.');
    this.send({ method: 'initialized' });
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const id = `codex-remote:init:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out.`));
      }, this.connectTimeoutMs * 2);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.send({ id, method, params });
    });
  }

  private send(message: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex App Server 未连接。');
    }
    socket.send(JSON.stringify(message));
  }

  private handleMessage(message: unknown): void {
    if (!record(message)) throw new Error('Invalid App Server message.');
    if ('id' in message && !('method' in message)) {
      if (!messageId(message.id)) throw new Error('Invalid App Server response id.');
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(record(message.error) && typeof message.error.message === 'string'
          ? new NativeRpcError(message.error as { message: string; code?: number; data?: unknown })
          : new Error('App Server request failed.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ('id' in message && typeof message.method === 'string') {
      if (!messageId(message.id)) throw new Error('Invalid App Server request id.');
      const requestId = `app-server:${message.id}`;
      this.serverRequests.set(requestId, {
        id: message.id,
        method: message.method,
        params: message.params
      });
      this.emit('server-request', {
        requestId,
        method: message.method,
        params: message.params
      });
      return;
    }
    if (typeof message.method === 'string') {
      if (message.method === 'serverRequest/resolved') {
        const requestId = `app-server:${message.params?.requestId}`;
        this.serverRequests.delete(requestId);
        this.emit('resolved', requestId);
      }
      this.emit('event', { method: message.method, params: message.params });
      return;
    }
    throw new Error('Invalid App Server message shape.');
  }

  private disconnectSocket(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.activeEndpoint = null;
    try { socket.close(); } catch { /* Already closed. */ }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.serverRequests.clear();
    this.emit('disconnected', error);
  }
}
