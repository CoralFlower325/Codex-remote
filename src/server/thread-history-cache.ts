import type { ClientRpcMethod } from '../shared/protocol.js';
import type { TurnTiming } from '../shared/turn-timing.js';
import { readConversationHistoryPage, readThreadHistoryPage } from './thread-history.js';
import { readThreadTimings } from './thread-open.js';

type Request = (method: ClientRpcMethod, params: unknown) => Promise<unknown>;
type HistoryResult = Awaited<ReturnType<typeof readThreadHistoryPage>>;
type ConversationResult = Awaited<ReturnType<typeof readConversationHistoryPage>>;
type AnyHistoryResult = HistoryResult | ConversationResult;
type TimingsResult = Awaited<ReturnType<typeof readThreadTimings>>;

const MAX_ENTRIES = 600;
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_THREADS = 16;
const ENTRY_TTL_MS = 30 * 60_000;
const PREWARM_ITEM_CAP = 5200;
const PREWARM_PAGE_DELAY_MS = 25;
const PREWARM_RETRY_BACKOFF_MS = 30_000;
const FOREGROUND_QUIET_MS = 200;
const COVERAGE_PAGE_CAP = 50;
const COVERAGE_TURN_CAP = 20000;

interface Entry {
  value: AnyHistoryResult | TimingsResult;
  bytes: number;
  savedAt: number;
  threadId: string;
}

interface PrewarmState {
  generation: number;
  walking: boolean;
  done: boolean;
  failedAt: number;
  idleWaiters: Array<() => void>;
}

interface CoverageState {
  turns: Map<string, TurnTiming>;
  cursor: string | null;
  started: boolean;
  exhausted: boolean;
  chain: Promise<void>;
}

/**
 * Host-side cache for completed thread history. Older pages are keyed by
 * their native cursor, so tail growth never disturbs them; any native event
 * or action that can rewrite completed history drops the whole thread.
 * Cached history pages carry turn timings for every turn they reference, so
 * the client never has to chase the timings cursor chain per page.
 * Background prewarming walks the same fills at low priority after a thread
 * is opened; foreground reads always win the bridge. The entry, byte and
 * thread caps bound every per-thread state (pages, coverage frontiers,
 * prewarm states and fill stamps) under one LRU: a thread dropped by the
 * cap or by invalidation loses all of them together, and a completed
 * prewarm whose pages later expire or are evicted is marked not-done so it
 * can run again.
 */
export class ThreadHistoryCache {
  private entries = new Map<string, Entry>();
  private threadAccess = new Map<string, number>();
  private prewarms = new Map<string, PrewarmState>();
  private coverages = new Map<string, CoverageState>();
  // Fill-invalidation stamps, one token object per thread. A fill captures
  // its token and stores only if the map still holds that same object, so
  // deleting a dropped thread's token is itself the invalidation — the map
  // stays bounded by the thread cap like every other per-thread state.
  private stamps = new Map<string, object>();
  private foregroundInFlight = 0;
  private lastForegroundAt = 0;

  /** Stamp captured by fills; they store only while it is still current. */
  private stampOf(threadId: string): object {
    let token = this.stamps.get(threadId);
    if (!token) {
      token = {};
      this.stamps.set(threadId, token);
      this.touchThread(threadId);
    }
    return token;
  }

  /**
   * Register a thread in the shared LRU and enforce the thread cap over ALL
   * per-thread state (entries, coverages, prewarms, stamps): the coldest
   * threads beyond the cap are dropped whole, ancillary state included.
   */
  private touchThread(threadId: string): void {
    this.threadAccess.delete(threadId);
    this.threadAccess.set(threadId, Date.now());
    while (this.threadAccess.size > MAX_THREADS) {
      const coldest = this.threadAccess.keys().next().value as string | undefined;
      if (coldest === undefined || coldest === threadId) break;
      this.dropThread(coldest);
    }
  }

  /**
   * A cached page left the cache early (TTL expiry or LRU eviction), so a
   * walk that once completed is no longer fully cached: forget its done
   * flag so the next open can prewarm the thread again.
   */
  private notePageLost(threadId: string): void {
    const state = this.prewarms.get(threadId);
    if (state && state.done) {
      state.done = false;
      state.failedAt = 0;
    }
  }

  /** Run foreground work with priority over any prewarm walk. */
  async trackForeground<T>(work: () => Promise<T>): Promise<T> {
    this.foregroundInFlight += 1;
    this.lastForegroundAt = Date.now();
    try {
      return await work();
    } finally {
      this.foregroundInFlight -= 1;
      this.lastForegroundAt = Date.now();
    }
  }

  /** Completed older history page (descending), with turn coverage attached. */
  async historyPage(
    request: Request,
    threadId: string,
    cursor: string,
    limit: number,
    conversation: boolean
  ): Promise<AnyHistoryResult> {
    const key = `h:${JSON.stringify([threadId, cursor, limit, conversation ? 1 : 0])}`;
    const cached = this.read(key);
    if (cached) return cached as AnyHistoryResult;
    const stamp = this.stampOf(threadId);
    // Advance the timings frontier alongside the fill so coverage rarely
    // adds serial time of its own; coverTurns tops up only if still short.
    const advancing = this.advanceCoverage(request, threadId, 1);
    const page = conversation
      ? await readConversationHistoryPage(request, threadId, cursor, limit)
      : await readThreadHistoryPage(request, threadId, cursor, limit);
    // Coverage is an optimization: its failure must not fail a good page.
    await advancing.catch(() => undefined);
    const covered = await this.coverTurns(request, threadId, page);
    // A history-rewriting event may have landed mid-fill: the caller keeps
    // its page (its own revision guards apply), but it must not be cached.
    if (this.stamps.get(threadId) === stamp &&
        !('continuationError' in covered && covered.continuationError)) {
      this.store(key, threadId, covered);
    }
    return covered;
  }

  /** One cursor-chained turn-timings page (never the head page). */
  async timingsPage(request: Request, threadId: string, cursor: string): Promise<TimingsResult> {
    const key = `t:${JSON.stringify([threadId, cursor])}`;
    const cached = this.read(key);
    if (cached) return cached as TimingsResult;
    const stamp = this.stampOf(threadId);
    const page = await readThreadTimings(request, threadId, cursor);
    if (this.stamps.get(threadId) === stamp) this.store(key, threadId, page);
    return page;
  }

  private coverageState(threadId: string): CoverageState {
    let state = this.coverages.get(threadId);
    if (!state) {
      state = { turns: new Map(), cursor: null, started: false, exhausted: false, chain: Promise.resolve() };
      this.coverages.set(threadId, state);
      this.touchThread(threadId);
    }
    return state;
  }

  /** One native timings step into the frontier; steps are serialized per thread. */
  private coverageStep(request: Request, threadId: string, state: CoverageState): Promise<void> {
    const task = state.chain.then(async () => {
      if (state.exhausted) return;
      const result = !state.started
        ? await readThreadTimings(request, threadId, null)
        : state.cursor !== null
          ? await this.timingsPage(request, threadId, state.cursor)
          : null;
      state.started = true;
      if (!result) { state.exhausted = true; return; }
      result.turns.forEach((turn) => state.turns.set(turn.id, turn));
      state.cursor = result.turnsCursor;
      if (result.turnsCursor === null || state.turns.size > COVERAGE_TURN_CAP) state.exhausted = true;
    });
    state.chain = task.catch(() => undefined);
    return task;
  }

  /** Advance the frontier by up to `maxSteps` timings pages. */
  private async advanceCoverage(request: Request, threadId: string, maxSteps: number): Promise<void> {
    const state = this.coverageState(threadId);
    for (let step = 0; step < maxSteps && !state.exhausted; step++) {
      await this.coverageStep(request, threadId, state);
    }
  }

  /**
   * Attach timings for every turn the page references, resuming from the
   * per-thread frontier instead of re-walking the head. Turns are immutable
   * once completed and the client merges live timings over page timings, so a
   * memoized snapshot stays valid until the thread is invalidated. When the
   * walk cannot finish within the page cap the partial result keeps the
   * client's own bounded chase as a fallback.
   */
  private async coverTurns(request: Request, threadId: string, page: AnyHistoryResult): Promise<AnyHistoryResult> {
    const state = this.coverageState(threadId);
    const needed = new Set(page.items.map((entry) => entry.turnId));
    page.turns.forEach((turn) => needed.delete(turn.id));
    state.turns.forEach((_, id) => needed.delete(id));
    for (let hops = 0; needed.size && !state.exhausted && hops < COVERAGE_PAGE_CAP; hops++) {
      try {
        await this.coverageStep(request, threadId, state);
      } catch {
        break; // Partial coverage: the client's bounded chase remains as fallback.
      }
      state.turns.forEach((_, id) => needed.delete(id));
    }
    // Attach only this page's turns (from the page itself or the frontier);
    // anything still missing sits beyond the frontier cursor, so the client
    // chase starting there skips nothing.
    const attached = new Map(page.turns.map((turn) => [turn.id, turn]));
    for (const entry of page.items) {
      if (!attached.has(entry.turnId)) {
        const turn = state.turns.get(entry.turnId);
        if (turn) attached.set(entry.turnId, turn);
      }
    }
    if (!attached.size && !state.started) return page;
    return {
      ...page,
      turns: [...attached.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      turnsCursor: state.started ? state.cursor : page.turnsCursor
    };
  }

  /** Start (or nudge) the low-priority background fill for one thread. */
  prewarm(request: Request, threadId: string, startCursor: string | null): void {
    if (!startCursor) return;
    let state = this.prewarms.get(threadId);
    if (!state) {
      state = { generation: 0, walking: false, done: false, failedAt: 0, idleWaiters: [] };
      this.prewarms.set(threadId, state);
      this.touchThread(threadId);
    }
    // Entries may have expired in place since the walk completed; pruning
    // them here makes the start decision follow the cache's actual state
    // instead of a stale done flag.
    if (state.done) {
      let lost = false;
      for (const [key, entry] of this.entries) {
        if (entry.threadId === threadId && Date.now() - entry.savedAt >= ENTRY_TTL_MS) {
          this.entries.delete(key);
          lost = true;
        }
      }
      if (lost) this.notePageLost(threadId);
    }
    if (state.walking || state.done) return;
    if (state.failedAt && Date.now() - state.failedAt < PREWARM_RETRY_BACKOFF_MS) return;
    const generation = state.generation;
    state.walking = true;
    void this.walk(request, threadId, startCursor, state, generation)
      .catch(() => {
        if (state.generation === generation) state.failedAt = Date.now();
      })
      .finally(() => {
        // A superseded walk touches nothing: dropThread/clear already freed
        // the flag and released the waiters of the dead generation.
        if (state.generation !== generation) return;
        state.walking = false;
        state.idleWaiters.splice(0).forEach((resolve) => resolve());
      });
  }

  /** Resolves when no prewarm walk is running for the thread (tests/probes). */
  prewarmIdle(threadId: string): Promise<void> {
    const state = this.prewarms.get(threadId);
    if (!state || !state.walking) return Promise.resolve();
    return new Promise((resolve) => { state.idleWaiters.push(resolve); });
  }

  private async walk(request: Request, threadId: string, startCursor: string,
    state: PrewarmState, generation: number): Promise<void> {
    // The walk owns the state object it started with; if the thread was
    // dropped and a fresh state took its place, this walk is orphaned and
    // must not mark the new generation done or clear its flag.
    const current = () => this.prewarms.get(threadId) === state && state.generation === generation;
    let cursor: string | null = startCursor;
    let items = 0;
    while (cursor !== null && items < PREWARM_ITEM_CAP) {
      if (!current()) return;
      await this.waitForForegroundQuiet(current);
      if (!current()) return;
      const page: AnyHistoryResult = await this.historyPage(request, threadId, cursor, 100, true);
      items += page.items.length;
      cursor = page.nextCursor;
      if (cursor !== null) await sleep(PREWARM_PAGE_DELAY_MS);
    }
    if (current() && cursor === null) state.done = true;
  }

  private async waitForForegroundQuiet(current: () => boolean): Promise<void> {
    while (current() &&
      (this.foregroundInFlight > 0 || Date.now() - this.lastForegroundAt < FOREGROUND_QUIET_MS)) {
      await sleep(50);
    }
  }

  private read(key: string): AnyHistoryResult | TimingsResult | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.savedAt >= ENTRY_TTL_MS) {
      this.entries.delete(key);
      this.notePageLost(entry.threadId);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.touchThread(entry.threadId);
    return entry.value;
  }

  private store(key: string, threadId: string, value: AnyHistoryResult | TimingsResult): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BYTES) return;
    this.entries.delete(key);
    this.entries.set(key, { value, bytes, savedAt: Date.now(), threadId });
    this.touchThread(threadId);
    this.trim(threadId);
  }

  private trim(protectedThread: string): void {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const lostThreads = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
      this.entries.delete(key);
      bytes -= entry.bytes;
      lostThreads.add(entry.threadId);
    }
    // Evicted pages break any completed walk's coverage of their thread:
    // its prewarm must be allowed to run again.
    for (const threadId of lostThreads) this.notePageLost(threadId);
  }

  dropThread(threadId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.threadId === threadId) this.entries.delete(key);
    }
    this.threadAccess.delete(threadId);
    this.coverages.delete(threadId);
    this.stamps.delete(threadId);
    const state = this.prewarms.get(threadId);
    if (state) {
      state.generation += 1;
      state.done = false;
      state.failedAt = 0;
      // The orphaned walk exits on its identity/generation check; free the
      // flag and any idle waiters so a later open can prewarm again
      // immediately, then remove the state itself: per-thread ancillary
      // state shares the entries' thread cap and must not linger unbounded.
      state.walking = false;
      state.idleWaiters.splice(0).forEach((resolve) => resolve());
      this.prewarms.delete(threadId);
    }
  }

  event(method: string, params: Record<string, unknown>): void {
    const thread = params.thread as { id?: string } | undefined;
    const threadId = typeof params.threadId === 'string' ? params.threadId : thread?.id;
    if (!threadId) return;
    if (method === 'thread/deleted' || method === 'thread/archived' || method === 'thread/unarchived' ||
      method === 'thread/reverted' || method === 'thread/revert' || method === 'thread/compacted') {
      this.dropThread(threadId);
    }
  }

  action(method: string, params: Record<string, unknown>): void {
    if (!/^thread\/(?:revert|archive|unarchive|compact\/start)$/.test(method)) return;
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    if (threadId) this.dropThread(threadId);
  }

  clear(): void {
    this.entries.clear();
    this.threadAccess.clear();
    this.coverages.clear();
    this.stamps.clear();
    for (const state of this.prewarms.values()) {
      state.generation += 1;
      state.done = false;
      state.failedAt = 0;
      state.walking = false;
      state.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
    this.prewarms.clear();
  }

  /** Entry counts for tests and probes. */
  stats(): { entries: number; threads: number; prewarming: number;
    coverages: number; prewarms: number; generations: number } {
    return {
      entries: this.entries.size,
      threads: this.threadAccess.size,
      prewarming: [...this.prewarms.values()].filter((state) => state.walking).length,
      coverages: this.coverages.size,
      prewarms: this.prewarms.size,
      generations: this.stamps.size
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
