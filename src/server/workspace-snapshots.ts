import type { ClientRpcMethod } from '../shared/protocol.js';
import { readThreadListPage, withReadDeadline } from './bootstrap.js';
import { readOpenThread, readThreadTimings } from './thread-open.js';

type Request = (method: ClientRpcMethod, params: unknown) => Promise<unknown>;
interface Snapshot {
  stale: boolean;
  savedAt: number;
}
interface Entry<T> {
  value?: T | undefined;
  savedAt: number;
  dirty: boolean;
  revision: number;
  bytes: number;
  removed?: boolean;
  pending?: Promise<T & { snapshot: Snapshot }> | undefined;
}

class SnapshotCache<T extends object> {
  private entries = new Map<string, Entry<T>>();

  constructor(private capacity: number, private maxBytes: number) {}

  read(key: string, load: () => Promise<T>, fresh = false): Promise<T & { snapshot: Snapshot }> {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { savedAt: 0, dirty: true, revision: 0, bytes: 0 };
      this.entries.set(key, entry);
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    const stale = entry.dirty || now - entry.savedAt >= 2000;
    if (entry.value && now - entry.savedAt < 5 * 60_000 && (!fresh || !stale)) {
      if (stale) void this.load(key, entry, load).catch(() => undefined);
      return Promise.resolve({ ...entry.value, snapshot: { stale, savedAt: entry.savedAt } });
    }
    return this.load(key, entry, load);
  }

  private load(key: string, entry: Entry<T>, load: () => Promise<T>): Promise<T & { snapshot: Snapshot }> {
    if (entry.pending) return entry.pending;
    const revision = entry.revision;
    entry.pending = withReadDeadline(load()).then(value => {
      if (entry.removed) throw new Error('This snapshot is no longer available.');
      const savedAt = Date.now();
      const stale = entry.revision !== revision;
      if (this.entries.get(key) === entry) {
        entry.savedAt = savedAt;
        entry.dirty = stale;
        entry.bytes = Buffer.byteLength(JSON.stringify(value));
        entry.value = entry.bytes <= this.maxBytes ? value : undefined;
        this.trim();
      }
      return { ...value, snapshot: { stale, savedAt } };
    }).catch(error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }

  private trim(): void {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.capacity && bytes <= this.maxBytes) break;
      // Keep unfinished reads shared; bounded completed snapshots are evicted first.
      if (entry.pending && !entry.value) continue;
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }

  invalidate(key?: string): void {
    for (const [id, entry] of this.entries) {
      if (key !== undefined && key !== id) continue;
      entry.dirty = true;
      entry.revision += 1;
    }
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.removed = true;
    this.entries.delete(key);
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }
}

type ThreadPage = { data: unknown[]; nextCursor: string | null };

export class WorkspaceSnapshots {
  private lists = new SnapshotCache<ThreadPage>(2, 2 * 1024 * 1024);
  private chats = new SnapshotCache<Awaited<ReturnType<typeof readOpenThread>>>(5, 8 * 1024 * 1024);
  private timings = new SnapshotCache<Awaited<ReturnType<typeof readThreadTimings>>>(5, 1024 * 1024);

  constructor(private request: Request) {}

  list(cursor: string | null = null, archived = false, fresh = false) {
    if (cursor) return withReadDeadline(readThreadListPage(this.request, cursor, archived));
    return this.lists.read(String(archived),
      () => readThreadListPage(this.request, null, archived) as Promise<ThreadPage>, fresh);
  }

  open(threadId: string, mode: 'resume' | 'read' | 'new', fresh = false) {
    if (mode === 'new') return withReadDeadline(readOpenThread(this.request, threadId, mode));
    return this.chats.read(threadId, () => readOpenThread(this.request, threadId, mode), fresh);
  }

  readTimings(threadId: string, fresh = false) {
    return this.timings.read(threadId, () => readThreadTimings(this.request, threadId), fresh);
  }

  event(method: string, params: Record<string, unknown>): void {
    const thread = params.thread as { id?: string } | undefined;
    const threadId = typeof params.threadId === 'string' ? params.threadId : thread?.id;
    if (/^(thread|turn)\//.test(method)) this.lists.invalidate();
    if (!threadId || !/^(thread|turn|item)\//.test(method)) return;
    if (method === 'thread/deleted' || method === 'thread/archived' || method === 'thread/reverted' || method === 'thread/revert') {
      this.lists.clear();
      this.chats.remove(threadId);
      this.timings.remove(threadId);
    } else {
      this.chats.invalidate(threadId);
      this.timings.invalidate(threadId);
    }
  }

  action(method: string, params: Record<string, unknown>): void {
    if (/^turn\/|^review\/start$|^thread\/(?:start|fork|revert|resume|archive|unarchive|name\/set|settings\/update|compact\/start|queue\/start)$/.test(method)) {
      this.event(method, params);
      this.lists.invalidate();
    }
  }

  clear(): void {
    this.lists.clear();
    this.chats.clear();
    this.timings.clear();
  }
}
