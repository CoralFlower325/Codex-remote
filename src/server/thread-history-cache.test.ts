import { describe, expect, it, vi } from 'vitest';
import { ThreadHistoryCache } from './thread-history-cache.js';

interface Entry { turnId: string; item: unknown; startedAtMs: number | null; completedAtMs: number | null }
interface Turn { id: string; status: 'completed'; startedAt: number; completedAt: number; durationMs: number;
  error?: { message: string } }

const user = (id: string, text: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
const agent = (id: string, text: string) => ({ type: 'agentMessage', id, phase: 'final_answer', text });
const cmd = (id: string) => ({ type: 'commandExecution', id, status: 'completed', command: 'x', aggregatedOutput: '' });

/** Ascending synthetic thread: `turnCount` turns of user + commands + answer. */
function buildThread(turnCount: number, itemsPerTurn = 6) {
  const items: Entry[] = [];
  const turns: Turn[] = [];
  for (let t = 0; t < turnCount; t++) {
    const id = `turn${t}`;
    turns.push({ id, status: 'completed', startedAt: 1000 + t * 100, completedAt: 1000 + t * 100 + 60, durationMs: 60000 });
    items.push({ turnId: id, item: user(`u${t}`, `问题 ${t}`), startedAtMs: null, completedAtMs: null });
    for (let i = 0; i < itemsPerTurn - 2; i++) {
      items.push({ turnId: id, item: cmd(`c${t}-${i}`), startedAtMs: null, completedAtMs: null });
    }
    items.push({ turnId: id, item: agent(`a${t}`, `答复 ${t}`), startedAtMs: null, completedAtMs: null });
  }
  return { items, turns };
}

function makeBridge(dataset: { items: Entry[]; turns: Turn[] }, failures?: (method: string, params: never) => boolean) {
  const counts = new Map<string, number>();
  const request = async (method: string, params: {
    limit?: number; sortDirection?: string; cursor?: string;
  }) => {
    counts.set(method, (counts.get(method) ?? 0) + 1);
    if (failures?.(method, params as never)) throw new Error('native read failed');
    if (method === 'thread/items/list') {
      const limit = params.limit ?? 100;
      let end = dataset.items.length;
      if (typeof params.cursor === 'string') end = Number(params.cursor.slice(1));
      const start = Math.max(0, end - limit);
      return { data: dataset.items.slice(start, end).reverse(), nextCursor: start > 0 ? `i${start}` : null };
    }
    if (method === 'thread/turns/list') {
      const limit = params.limit ?? 100;
      let end = dataset.turns.length;
      if (typeof params.cursor === 'string') end = Number(params.cursor.slice(1));
      const start = Math.max(0, end - limit);
      return { data: dataset.turns.slice(start, end).reverse(), nextCursor: start > 0 ? `t${start}` : null };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request: request as never, counts };
}

const rpc = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);

describe('ThreadHistoryCache', () => {
  it('serves a repeated older page without new native reads', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    const first = await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    const afterFirst = rpc(bridge.counts);
    const second = await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(second).toBe(first);
    expect(rpc(bridge.counts)).toBe(afterFirst);
    expect(first.items.length).toBeGreaterThan(0);
  });

  it('attaches timings for every turn referenced by an older page', async () => {
    const dataset = buildThread(90);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    // A deep page whose turns sit far behind the 40-turn timings head.
    const page = await cache.historyPage(bridge.request, 'thread', 'i240', 100, true);
    const covered = new Set(page.turns.map((turn) => turn.id));
    for (const entry of page.items) expect(covered.has(entry.turnId)).toBe(true);
    // Only the page's own turns are attached, not the whole walked frontier.
    const referenced = new Set(page.items.map((entry) => entry.turnId));
    expect(page.turns.length).toBe(referenced.size);
    // The frontier still advanced past the head, so the client chase is moot.
    expect(bridge.counts.get('thread/turns/list')).toBeGreaterThan(1);
  });

  it('prewarms the cursor chain so later pages need no native reads', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    cache.prewarm(bridge.request, 'thread', 'i180');
    await cache.prewarmIdle('thread');
    const afterPrewarm = rpc(bridge.counts);
    expect(afterPrewarm).toBeGreaterThan(0);
    expect(cache.stats().entries).toBeGreaterThan(0);
    // The walk filled the chain cursors the client will actually request.
    const page = await cache.historyPage(bridge.request, 'thread', 'i180', 100, true);
    expect(page.items.length).toBeGreaterThan(0);
    const next = await cache.historyPage(bridge.request, 'thread', page.nextCursor as string, 100, true);
    expect(next.items.length).toBeGreaterThan(0);
    expect(rpc(bridge.counts)).toBe(afterPrewarm);
  });

  it('keeps foreground work ahead of the prewarm walk', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    let releaseForeground: () => void = () => undefined;
    const foregroundGate = new Promise<void>((resolve) => { releaseForeground = resolve; });
    const foreground = cache.trackForeground(() => foregroundGate);
    cache.prewarm(bridge.request, 'thread', 'i180');
    // Give the walk several chances to start; it must stay parked.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(bridge.counts.get('thread/items/list') ?? 0).toBe(0);
    releaseForeground();
    await foreground;
    await cache.prewarmIdle('thread');
    expect(bridge.counts.get('thread/items/list') ?? 0).toBeGreaterThan(0);
  });

  it('drops a thread on history-mutating events and actions, not on tail growth', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    const filled = rpc(bridge.counts);
    cache.event('turn/completed', { threadId: 'thread' });
    cache.event('item/completed', { threadId: 'thread' });
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(rpc(bridge.counts)).toBe(filled);
    cache.event('thread/reverted', { threadId: 'thread' });
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(rpc(bridge.counts)).toBeGreaterThan(filled);
    const refilled = rpc(bridge.counts);
    cache.action('thread/compact/start', { threadId: 'thread' });
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(rpc(bridge.counts)).toBeGreaterThan(refilled);
  });

  it('does not cache pages that carry a continuation error', async () => {
    // One turn of pure command output: a 100-item window holds no readable
    // item, so the conversation read continues to an older native page --
    // which fails here, so the page returns with continuationError set.
    const items: Entry[] = [{ turnId: 'turn0', item: user('u0', '长任务'), startedAtMs: null, completedAtMs: null }];
    for (let i = 0; i < 300; i++) items.push({ turnId: 'turn0', item: cmd(`c${i}`), startedAtMs: null, completedAtMs: null });
    items.push({ turnId: 'turn0', item: agent('a0', '完成'), startedAtMs: null, completedAtMs: null });
    const dataset = { items, turns: [{ id: 'turn0', status: 'completed' as const, startedAt: 1000, completedAt: 1060, durationMs: 60000 }] };
    const bridge = makeBridge(dataset, (method, params) =>
      method === 'thread/items/list' && (params as { cursor?: string }).cursor === 'i201');
    const cache = new ThreadHistoryCache();
    const first = await cache.historyPage(bridge.request, 'thread', 'i301', 100, true);
    expect('continuationError' in first && first.continuationError).toBeTruthy();
    const afterFirst = rpc(bridge.counts);
    await cache.historyPage(bridge.request, 'thread', 'i301', 100, true);
    expect(rpc(bridge.counts)).toBeGreaterThan(afterFirst);
  });

  it('does not cache a page whose fill raced a history-mutating event', async () => {
    const dataset = buildThread(30);
    let cache!: ThreadHistoryCache;
    let raced = false;
    const bridge = makeBridge(dataset, (method) => {
      // The revert lands while the first page fill is in flight.
      if (method === 'thread/items/list' && !raced) {
        raced = true;
        cache.event('thread/reverted', { threadId: 'thread' });
      }
      return false;
    });
    cache = new ThreadHistoryCache();
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    const afterRacedFill = rpc(bridge.counts);
    // Not served from cache: the raced page was returned but never stored.
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(rpc(bridge.counts)).toBeGreaterThan(afterRacedFill);
    const afterCleanFill = rpc(bridge.counts);
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(rpc(bridge.counts)).toBe(afterCleanFill);
  });

  it('restarts prewarm after an invalidation stopped the walk', async () => {
    const dataset = buildThread(100);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    cache.prewarm(bridge.request, 'thread', 'i600');
    cache.event('thread/reverted', { threadId: 'thread' });
    await cache.prewarmIdle('thread');
    const before = rpc(bridge.counts);
    cache.prewarm(bridge.request, 'thread', 'i600');
    await cache.prewarmIdle('thread');
    expect(rpc(bridge.counts)).toBeGreaterThan(before);
    const afterWalk = rpc(bridge.counts);
    await cache.historyPage(bridge.request, 'thread', 'i500', 100, true);
    expect(rpc(bridge.counts)).toBe(afterWalk);
  });

  it('bounds the number of cached entries', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    for (let index = 170; index > 0; index -= 1) {
      await cache.timingsPage(bridge.request, 'thread', `t${index}`);
    }
    expect(cache.stats().entries).toBeLessThanOrEqual(600);
    // Force overflow with distinct large pages across many cursors.
    for (let index = 0; index < 700; index++) {
      await cache.historyPage(bridge.request, 'thread', `i${1000 + index}`, 100, true);
    }
    expect(cache.stats().entries).toBeLessThanOrEqual(600);
  });

  it('prewarms again after the walked pages expire under the TTL', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    let now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      cache.prewarm(bridge.request, 'thread', 'i180');
      await cache.prewarmIdle('thread');
      const afterFirstWalk = rpc(bridge.counts);
      expect(afterFirstWalk).toBeGreaterThan(0);
      // Still fresh: a nudge does not re-walk.
      cache.prewarm(bridge.request, 'thread', 'i180');
      await cache.prewarmIdle('thread');
      expect(rpc(bridge.counts)).toBe(afterFirstWalk);
      // Every cached page expires; the next open must prewarm again rather
      // than trusting the completed walk's stale done flag — and a second
      // concurrent nudge must not start a duplicate walk.
      now += 31 * 60_000;
      cache.prewarm(bridge.request, 'thread', 'i180');
      cache.prewarm(bridge.request, 'thread', 'i180');
      expect(cache.stats().prewarming).toBe(1);
      await cache.prewarmIdle('thread');
      expect(rpc(bridge.counts)).toBeGreaterThan(afterFirstWalk);
      const afterSecondWalk = rpc(bridge.counts);
      await cache.historyPage(bridge.request, 'thread', 'i180', 100, true);
      expect(rpc(bridge.counts)).toBe(afterSecondWalk);
    } finally {
      spy.mockRestore();
    }
  });

  it('prewarms again after LRU eviction removes the walked pages', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    cache.prewarm(bridge.request, 'victim', 'i180');
    await cache.prewarmIdle('victim');
    expect(cache.stats().entries).toBeGreaterThan(0);
    // Flood the entry cap from another thread; the victim's pages are the
    // oldest entries and are evicted first.
    for (let index = 1; index <= 700; index++) {
      await cache.timingsPage(bridge.request, 'flood', `t${index}`);
    }
    expect(cache.stats().entries).toBeLessThanOrEqual(600);
    const afterFlood = rpc(bridge.counts);
    cache.prewarm(bridge.request, 'victim', 'i180');
    await cache.prewarmIdle('victim');
    expect(rpc(bridge.counts)).toBeGreaterThan(afterFlood);
    const afterWalk = rpc(bridge.counts);
    await cache.historyPage(bridge.request, 'victim', 'i180', 100, true);
    expect(rpc(bridge.counts)).toBe(afterWalk);
  });

  it('does not mark prewarm done when a page is evicted while the walk is running', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    // Gate the walk's second page: the first page is already cached while
    // the walk is parked on the native read for the second.
    const rawRequest = bridge.request as unknown as (method: string, params: unknown) => Promise<unknown>;
    let itemsCalls = 0;
    let releaseSecondPage!: () => void;
    let markSecondPageStarted!: () => void;
    const secondPageGate = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
    const secondPageStarted = new Promise<void>((resolve) => { markSecondPageStarted = resolve; });
    const gatedRequest = async (method: string, params: unknown) => {
      if (method === 'thread/items/list') {
        itemsCalls += 1;
        if (itemsCalls === 2) {
          markSecondPageStarted();
          await secondPageGate;
        }
      }
      return rawRequest(method, params);
    };
    cache.prewarm(gatedRequest as never, 'victim', 'i180');
    await secondPageStarted;
    // Flood the entry cap from another thread: the victim's already-walked
    // pages are the oldest entries and are evicted mid-walk.
    for (let index = 1; index <= 700; index++) {
      await cache.timingsPage(bridge.request, 'flood', `t${index}`);
    }
    releaseSecondPage();
    await cache.prewarmIdle('victim');
    const afterFirstWalk = rpc(bridge.counts);
    // The walk finished its chain, but a page it walked is gone, so it
    // must not have claimed done: the next nudge walks again and refills
    // the missing page instead of trusting the incomplete cache.
    cache.prewarm(bridge.request, 'victim', 'i180');
    await cache.prewarmIdle('victim');
    expect(rpc(bridge.counts)).toBeGreaterThan(afterFirstWalk);
    // The second walk completed over a full cache, so now the walked
    // pages really are served without native reads.
    const afterSecondWalk = rpc(bridge.counts);
    await cache.historyPage(bridge.request, 'victim', 'i180', 100, true);
    expect(rpc(bridge.counts)).toBe(afterSecondWalk);
  });

  it('charges coverage timings against the shared byte budget', async () => {
    // Each timing carries an 8 KiB error payload, so a few thousand
    // retained timings are enough to reach the 48 MiB budget on the
    // serialized-size yardstick the cache charges them with.
    const payload = 'x'.repeat(8192);
    const turns: Turn[] = Array.from({ length: 8000 }, (_, index) => ({
      id: `turn${index}`, status: 'completed' as const, startedAt: 1000 + index * 100,
      completedAt: 1000 + index * 100 + 60, durationMs: 60000, error: { message: payload }
    }));
    const items: Entry[] = turns.map((turn, index) => ({
      turnId: turn.id, item: user(`u${index}`, '问题'), startedAtMs: null, completedAtMs: null
    }));
    const bridge = makeBridge({ items, turns });
    const cache = new ThreadHistoryCache();
    // Two deep pages drive the coverage frontier thousands of turns back
    // from the head; without coverage accounting the frontier alone would
    // retain well over the byte budget.
    await cache.historyPage(bridge.request, 'thread', 'i100', 100, true);
    await cache.historyPage(bridge.request, 'thread', 'i200', 100, true);
    const stats = cache.stats();
    expect(stats.coverageBytes).toBeGreaterThan(40 * 1024 * 1024);
    expect(stats.totalBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(stats.entryBytes + stats.coverageBytes).toBe(stats.totalBytes);
    // Dropping the thread releases its coverage bytes with everything else.
    cache.event('thread/reverted', { threadId: 'thread' });
    expect(cache.stats().coverageBytes).toBe(0);
    expect(cache.stats().totalBytes).toBe(0);
  });

  it('drops ancillary per-thread state together with the thread', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    cache.prewarm(bridge.request, 'thread', 'i120');
    await cache.prewarmIdle('thread');
    expect(cache.stats().coverages).toBe(1);
    expect(cache.stats().prewarms).toBe(1);
    expect(cache.stats().generations).toBeGreaterThan(0);
    cache.event('thread/reverted', { threadId: 'thread' });
    expect(cache.stats()).toMatchObject({ entries: 0, threads: 0, coverages: 0, prewarms: 0, generations: 0 });
    // A whole-cache clear after refilling leaves no ancillary state either.
    await cache.historyPage(bridge.request, 'thread', 'i120', 100, true);
    expect(cache.stats().entries).toBeGreaterThan(0);
    cache.clear();
    expect(cache.stats()).toMatchObject({ entries: 0, threads: 0, coverages: 0, prewarms: 0, generations: 0 });
  });

  it('bounds ancillary per-thread state under the same thread cap as entries', async () => {
    const dataset = buildThread(30);
    const bridge = makeBridge(dataset);
    const cache = new ThreadHistoryCache();
    const ids = Array.from({ length: 24 }, (_, index) => `bulk${index}`);
    for (const id of ids) {
      await cache.historyPage(bridge.request, id, 'i120', 100, true);
      cache.prewarm(bridge.request, id, 'i120');
    }
    await Promise.all(ids.map((id) => cache.prewarmIdle(id)));
    const stats = cache.stats();
    expect(stats.threads).toBeLessThanOrEqual(16);
    expect(stats.coverages).toBeLessThanOrEqual(16);
    expect(stats.prewarms).toBeLessThanOrEqual(16);
    expect(stats.generations).toBeLessThanOrEqual(16);
    expect(stats.entries).toBeLessThanOrEqual(600);
  });
});
