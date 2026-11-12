import { describe, expect, it, vi } from 'vitest';
import {
  EarlierPageChain, HistoryPrefetch, invalidateAfterCompaction, isReadableHistoryItem,
  prefetchAttemptKey, prepareHistoryPage
} from './history-prefetch';
import type { ThreadHistoryPage } from './types';
import type { TurnTiming } from '../shared/turn-timing';

const turn = (id: string): TurnTiming => ({ id, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 });
const page: ThreadHistoryPage = {
  items: [{ turnId: 'older', item: { type: 'agentMessage', id: 'answer', text: 'Answer' },
    startedAtMs: 1000, completedAtMs: 2000 }],
  nextCursor: 'before-older', activeTurnId: null, turns: [], turnsCursor: null
};

describe('silent history preparation', () => {
  it('continues past folded activity and commentary but stops for real conversation', () => {
    expect(isReadableHistoryItem({ type: 'reasoning', id: 'r', summary: ['Hidden'], content: [] })).toBe(false);
    expect(isReadableHistoryItem({ type: 'agentMessage', id: 'c', phase: 'commentary', text: 'Progress' })).toBe(false);
    expect(isReadableHistoryItem({ type: 'agentMessage', id: 'p', phase: 'partial_answer', text: 'Progress' })).toBe(false);
    expect(isReadableHistoryItem({ type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'Answer' })).toBe(true);
    expect(isReadableHistoryItem({ type: 'agentMessage', id: 'legacy', text: 'Legacy reply' })).toBe(true);
  });

  it('recognizes image-only questions without counting blank messages as new context', () => {
    expect(isReadableHistoryItem({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: '  ' }] })).toBe(false);
    expect(isReadableHistoryItem({ type: 'agentMessage', id: 'a', text: '  ' })).toBe(false);
    expect(isReadableHistoryItem({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Question' }] })).toBe(true);
    expect(isReadableHistoryItem({ type: 'userMessage', id: 'u', content: [{ type: 'localImage', path: '/question.png' }] })).toBe(true);
  });

  it('shares the pending and completed speculative page with the reader', async () => {
    const buffer = new HistoryPrefetch();
    let finish!: (value: ThreadHistoryPage) => void;
    const load = vi.fn(() => new Promise<ThreadHistoryPage>(resolve => { finish = resolve; }));
    const speculative = buffer.read('cursor', load);
    expect(buffer.read('cursor', load)).toBe(speculative);
    finish(page);
    await expect(speculative).resolves.toBe(page);
    await expect(buffer.read('cursor', load)).resolves.toBe(page);
    expect(load).toHaveBeenCalledTimes(1);
    buffer.clear();
    const next = vi.fn(async () => page);
    await buffer.read('next', next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('abandons a prior selection without retaining its result', async () => {
    const buffer = new HistoryPrefetch();
    let finish!: (value: ThreadHistoryPage) => void;
    const stale = buffer.read('previous-thread', () => new Promise(resolve => { finish = resolve; }));
    const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    await buffer.read('next-thread', async () => page);
    finish(page);
    await rejected;
  });

  it('allows a foreground retry after speculative failure', async () => {
    const buffer = new HistoryPrefetch();
    await expect(buffer.read('cursor', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(buffer.read('cursor', async () => page)).resolves.toBe(page);
  });

  it('prepares all missing timing pages without advancing the visible cursors', async () => {
    const readTurns = vi.fn(async (cursor: string) => cursor === 'first'
      ? { data: [turn('middle')], nextCursor: 'second' }
      : { data: [turn('older')], nextCursor: 'third' });
    const known = { current: turn('current') };
    const prepared = await prepareHistoryPage(async () => page, readTurns, known, 'first', new AbortController().signal);
    expect(readTurns.mock.calls.map(([cursor]) => cursor)).toEqual(['first', 'second']);
    expect(prepared.turns.map(turn => turn.id)).toEqual(['middle', 'older']);
    expect(prepared.turnsCursor).toBe('third');
    expect(Object.keys(known)).toEqual(['current']);
    expect(page.turns).toEqual([]);
  });

  it('does not request timing already known or continue native reads after cancellation', async () => {
    const readTurns = vi.fn(async () => ({ data: [], nextCursor: null }));
    await prepareHistoryPage(async () => page, readTurns, { older: turn('older') }, 'cursor', new AbortController().signal);
    expect(readTurns).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareHistoryPage(async () => page, readTurns, {}, 'cursor', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(readTurns).not.toHaveBeenCalled();
  });
});

describe('prepared earlier chain and compaction invalidation', () => {
  it('shares a prepared successor page and hands it out exactly once', async () => {
    const chain = new EarlierPageChain();
    const load = vi.fn(async () => page);
    const first = chain.prepare('cursor', load);
    expect(chain.prepare('cursor', load)).toBe(first);
    await expect(first).resolves.toBe(page);
    expect(chain.take('cursor')).toBe(first);
    expect(chain.take('cursor')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight successor fills when the chain is cleared', async () => {
    const chain = new EarlierPageChain();
    let signal!: AbortSignal;
    const pending = chain.prepare('cursor', (abortSignal) => {
      signal = abortSignal;
      return new Promise<ThreadHistoryPage>(() => {});
    });
    void pending;
    chain.clear();
    expect(signal.aborted).toBe(true);
    expect(chain.take('cursor')).toBeNull();
  });

  it('compaction drops prepared pages and the cached latest page', async () => {
    const prefetch = new HistoryPrefetch();
    const chain = new EarlierPageChain();
    const historyCache = new Map<string, ThreadHistoryPage>([['thread', page], ['other', page]]);
    const speculativeLoad = vi.fn(async () => page);
    await prefetch.read('speculative', speculativeLoad);
    await chain.prepare('chained', async () => page);
    let chainSignal!: AbortSignal;
    const inFlight = chain.prepare('in-flight', (abortSignal) => {
      chainSignal = abortSignal;
      return new Promise<ThreadHistoryPage>(() => {});
    });
    void inFlight;

    invalidateAfterCompaction('thread', { prefetch, chain, historyCache });

    // The thread's cached latest page is gone; other threads keep theirs.
    expect(historyCache.has('thread')).toBe(false);
    expect(historyCache.get('other')).toBe(page);
    // No prepared page survives: the chain is empty and in-flight fills abort.
    expect(chain.take('chained')).toBeNull();
    expect(chainSignal.aborted).toBe(true);
    // The speculative page is re-read instead of serving the pre-compaction one.
    await prefetch.read('speculative', speculativeLoad);
    expect(speculativeLoad).toHaveBeenCalledTimes(2);
  });

  it('compaction rejects a taken-but-uncommitted page and drops the device snapshot', async () => {
    const chain = new EarlierPageChain();
    const prefetch = new HistoryPrefetch();
    const historyCache = new Map<string, ThreadHistoryPage>([['thread', page]]);
    // The foreground takes the prepared page out of the chain; from here
    // on, chain.clear() can no longer abort its promise.
    const preparedPage = chain.prepare('cursor', async () => page);
    const taken = chain.take('cursor');
    expect(taken).toBe(preparedPage);
    expect(chain.take('cursor')).toBeNull();
    // The load that took the page captured the history revision, exactly
    // like loadEarlierHistory does before awaiting the page; it commits
    // only if that revision is still current when the page lands.
    const historyRevision = { current: 7 };
    const loadRevision = historyRevision.current;
    const deviceSnapshots = new Map<string, ThreadHistoryPage>([['thread', page], ['other', page]]);
    const removeDeviceSnapshot = vi.fn((threadId: string) => { deviceSnapshots.delete(threadId); });

    invalidateAfterCompaction('thread', { prefetch, chain, historyCache }, {
      advanceHistoryRevision: () => { historyRevision.current += 1; },
      removeDeviceSnapshot
    });

    // The taken promise itself still resolves — it cannot be aborted —
    // but the revision it was captured under is stale, so the simulated
    // commit path (same check as loadEarlierHistory) rejects the page.
    await expect(taken as Promise<ThreadHistoryPage>).resolves.toBe(page);
    let committed = false;
    if (historyRevision.current === loadRevision) committed = true;
    expect(committed).toBe(false);
    expect(historyRevision.current).toBe(loadRevision + 1);
    // The offline device snapshot for the compacted thread is dropped;
    // other threads keep theirs.
    expect(removeDeviceSnapshot).toHaveBeenCalledWith('thread');
    expect(deviceSnapshots.has('thread')).toBe(false);
    expect(deviceSnapshots.get('other')).toBe(page);
  });
});

describe('prefetch attempt dedup key', () => {
  it('distinguishes direction so an underfilled first prefetch cannot block upward deep prefetch', () => {
    const settled = prefetchAttemptKey('thread', 'head-item', 40, 'settled');
    const earlier = prefetchAttemptKey('thread', 'head-item', 40, 'earlier');
    expect(earlier).not.toBe(settled);
    // Same direction over the same head still dedups.
    expect(prefetchAttemptKey('thread', 'head-item', 40, 'earlier')).toBe(earlier);
    expect(prefetchAttemptKey('thread', 'head-item', 40, 'settled')).toBe(settled);
    // And the head/count components still distinguish different windows.
    expect(prefetchAttemptKey('thread', 'other-head', 40, 'earlier')).not.toBe(earlier);
    expect(prefetchAttemptKey('thread', 'head-item', 41, 'earlier')).not.toBe(earlier);
  });
});
