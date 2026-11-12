import type { TurnTiming } from '../shared/turn-timing';
import type { ThreadHistoryPage } from './types';
export { isReadableHistoryItem } from '../shared/history-context';

/** One speculative page, shared with the foreground reader and never persisted. */
export class HistoryPrefetch {
  private entry: { key: string; controller: AbortController; promise: Promise<ThreadHistoryPage> } | null = null;

  read(key: string, load: (signal: AbortSignal) => Promise<ThreadHistoryPage>): Promise<ThreadHistoryPage> {
    if (this.entry?.key === key) return this.entry.promise;
    this.clear();
    const controller = new AbortController();
    const promise = load(controller.signal).then(page => {
      controller.signal.throwIfAborted();
      return page;
    }).catch(error => {
      if (this.entry?.controller === controller) this.entry = null;
      throw error;
    });
    this.entry = { key, controller, promise };
    return promise;
  }

  clear(): void {
    this.entry?.controller.abort();
    this.entry = null;
  }
}

/**
 * Successor pages prepared while upward travel lasts, keyed like the
 * immediate speculative page. Commits take a page out of the chain instead
 * of consuming it speculatively; clearing aborts every in-flight fill so a
 * stale chain can never be served after its history was rewritten.
 */
export class EarlierPageChain {
  private entries = new Map<string, { controller: AbortController; promise: Promise<ThreadHistoryPage> }>();

  prepare(key: string, load: (signal: AbortSignal) => Promise<ThreadHistoryPage>): Promise<ThreadHistoryPage> {
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const entry = { controller, promise: load(controller.signal) };
    this.entries.set(key, entry);
    entry.promise.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.promise;
  }

  /** Remove and return the prepared page for `key`, if one is held. */
  take(key: string): Promise<ThreadHistoryPage> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return entry.promise;
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }
}

/** Side effects a compaction invalidation must have beyond prepared pages. */
export interface CompactionInvalidationEffects {
  /**
   * Advance the history revision. Clearing the chain cannot abort a page
   * that take() already handed to the foreground, so a taken-but-uncommitted
   * page is stopped only by making its captured revision stale: the commit
   * path rechecks the revision and must reject it after compaction.
   */
  advanceHistoryRevision?: () => void;
  /** Drop the thread's offline device snapshot, which holds pre-compaction history. */
  removeDeviceSnapshot?: (threadId: string) => void;
}

/**
 * Compaction rewrites a thread's completed history, so every page prepared
 * or cached from the pre-compaction chain is stale: abort the speculative
 * page and the whole successor chain, drop the thread's cached latest
 * page, advance the history revision so a page already taken by the
 * foreground cannot commit, and drop the offline device snapshot.
 * Without this, the post-compaction refresh could still serve pages
 * keyed by cursors that compaction replaced.
 */
export function invalidateAfterCompaction(threadId: string, prepared: {
  prefetch: HistoryPrefetch;
  chain: EarlierPageChain;
  historyCache: Map<string, ThreadHistoryPage>;
}, effects: CompactionInvalidationEffects = {}): void {
  prepared.prefetch.clear();
  prepared.chain.clear();
  prepared.historyCache.delete(threadId);
  effects.advanceHistoryRevision?.();
  effects.removeDeviceSnapshot?.(threadId);
}

/** Direction a speculative earlier-history prefetch is preparing for. */
export type PrefetchDirection = 'earlier' | 'settled';

/**
 * Dedup key for one speculative prefetch attempt. The direction is part of
 * the key: an underfilled/settled first prefetch (one page) must not dedup
 * away the deeper prefetch (three pages) that upward travel intent asks
 * for over the same head item.
 */
export function prefetchAttemptKey(threadId: string, headKey: string, itemCount: number,
  direction: PrefetchDirection): string {
  return JSON.stringify([threadId, headKey, itemCount, direction]);
}

export async function prepareHistoryPage(
  readPage: () => Promise<ThreadHistoryPage>,
  readTurns: (cursor: string) => Promise<{ data: TurnTiming[]; nextCursor: string | null }>,
  knownTurns: Record<string, TurnTiming>,
  turnsCursor: string | null,
  signal: AbortSignal
): Promise<ThreadHistoryPage> {
  const page = await readPage();
  signal.throwIfAborted();
  const turns = [...page.turns];
  const known = new Set([...Object.keys(knownTurns), ...turns.map(turn => turn.id)]);
  const missing = new Set(page.items.map(entry => entry.turnId).filter(id => !known.has(id)));
  while (missing.size && turnsCursor !== null) {
    const result = await readTurns(turnsCursor);
    signal.throwIfAborted();
    turns.push(...result.data);
    result.data.forEach(turn => missing.delete(turn.id));
    const previous = turnsCursor;
    turnsCursor = result.nextCursor;
    if (turnsCursor === previous) break;
  }
  return { ...page, turns, turnsCursor };
}
