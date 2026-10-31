import type { ClientRpcMethod } from './rpc-methods.js';
export type { ClientRpcMethod } from './rpc-methods.js';

export type ClientMessage =
  | { type: 'rpc'; id: string; method: ClientRpcMethod; params?: unknown }
  | { type: 'server.request.respond'; requestId: string | number; result?: unknown; error?: unknown }
  | { type: 'thread.watch'; threadId: string | null; additionalThreadIds?: string[] }
  | { type: 'sync.resume'; epoch: string | null; after: number; threadId: string | null; additionalThreadIds?: string[] }
  | { type: 'ping' };

export type ServerMessage = (
  | { type: 'hello'; connectedAt: string; codexAvailable: boolean; binary: string }
  | { type: 'rpc.result'; id: string; result: unknown }
  | { type: 'rpc.error'; id: string; error: { code?: number; message: string; data?: unknown } }
  | { type: 'event'; method: string; params: unknown }
  | { type: 'questions.snapshot'; counts: Record<string, number> }
  | { type: 'server.request.snapshot'; requests: Array<{ requestId: string | number; method: string; params: unknown }> }
  | { type: 'server.request'; requestId: string | number; method: string; params: unknown }
  | { type: 'server.request.resolved'; requestId: string | number }
  | { type: 'server.request.failed'; requestId: string | number; error: { message: string } }
  | { type: 'bridge.status'; status: 'starting' | 'ready' | 'restarting' | 'offline'; message?: string }
  | { type: 'pong'; at: string }
  | { type: 'sync.ready'; epoch: string; sequence: number; resumed: boolean }
  | { type: 'error'; error: { message: string } }
) & { sequence?: number; epoch?: string };

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}
