import { v4 as randomUUID } from 'uuid';
import type { ClientRpcMethod } from '../shared/protocol';
import { prioritizeInteraction } from './background-work';
import { actionIntent } from './action-intents';
import type { RemoteChannel } from './remote-connection';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutReject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteRequestRegistry {
  private readonly pending = new Map<string, PendingRequest>();

  get size(): number {
    return this.pending.size;
  }

  request<T>(socket: RemoteChannel, method: ClientRpcMethod, params: unknown = {}): Promise<T> {
    if (/^(turn\/|thread\/queue\/|review\/)/.test(method)) prioritizeInteraction();
    const id = randomUUID();
    const intent = actionIntent(method, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.timeoutReject(new Error(intent
          ? '操作结果尚未确认，请先核对 Desktop 中的记录；重新连接不会重发此操作。'
          : `请求超时：${method}`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => {
          intent?.complete();
          resolve(value as T);
        },
        reject: error => {
          if (intent && !('code' in error)) {
            reject(new Error('操作结果尚未确认，可能已经执行。请先核对 Desktop 中的记录；重新连接不会重发此操作。',
              { cause: error }));
          } else {
            intent?.complete();
            reject(error);
          }
        },
        timeoutReject: reject,
        timer
      });
      try {
        socket.send(JSON.stringify({ type: 'rpc', id, method, params,
          ...(intent ? { actionId: intent.id } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  resolve(id: string, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(value);
  }

  reject(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
