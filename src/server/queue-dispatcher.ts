import type { ClientRpcMethod } from '../shared/protocol.js';

type Rpc = <T>(method: ClientRpcMethod, params: unknown) => Promise<T>;

export class QueueDispatcher {
  private threads = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  constructor(private rpc: Rpc,
    private report: (threadId: string, message: string) => void = () => {
      console.warn('[queue] 派发未确认，保留原生队列，等待恢复后重新核对。');
    }) {}

  async recover(): Promise<void> {
    await Promise.all([...this.threads].map(threadId => this.drain(threadId)));
  }

  track(threadId: string) {
    this.threads.add(threadId);
    return this.drain(threadId);
  }

  drain(threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) return Promise.resolve();
    const existing = this.running.get(threadId);
    if (existing) { this.pending.add(threadId); return existing; }
    const request = (async () => {
      const { data } = await this.rpc<{ data: Array<{ id: string }> }>('thread/queue/list', { threadId, limit: 1 });
      if (!data[0]) { this.threads.delete(threadId); return; }
      const { thread } = await this.rpc<{ thread: { status: { type: string } } }>('thread/read', { threadId, includeTurns: false });
      if (thread.status.type === 'active') return;
      // The native queue consumes the selected id atomically, including Desktop dispatch.
      await this.rpc('thread/queue/start', { threadId, queuedSubmissionId: data[0].id });
    })().catch(() => {
      this.report(threadId, '待发消息派发未确认，消息仍由原生队列管理。连接恢复后会先核对队列；也可检查会话后手动发送。');
    }).finally(() => {
      this.running.delete(threadId);
      if (this.pending.delete(threadId)) void this.drain(threadId);
    });
    this.running.set(threadId, request);
    return request;
  }
}
