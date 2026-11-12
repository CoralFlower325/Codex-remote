import { describe, expect, it } from 'vitest';
import {
  buildTimelineEntries, buildTimelineSections, projectTimeline,
  type TimelineChainCache, type TimelineSection
} from './timeline-model';
import type { ThreadItem } from './types';

/**
 * Prepend-path equivalence and path selection. The chain's prepend splice is
 * pinned to the same legacy two-builder oracle as the rest of the
 * chain; these tests drive the shapes a history pager actually
 * produces (whole-turn pages, pages cutting a turn mid-flight, pages
 * ending on a steering message, sequential pages, and a tail trim at
 * the retention cap) and then verify that a prepend takes the splice
 * path, reusing the retained window instead of rebuilding it.
 */
class Oracle {
  private legacySections: TimelineSection[] = [];
  private cache: TimelineChainCache | null = null;

  step(items: ThreadItem[], activeTurnId: string | null = null): TimelineChainCache {
    const snapshot = [...items];
    const legacyEntries = buildTimelineEntries(snapshot, activeTurnId,
      this.legacySections.flatMap(section => section.entries));
    const legacyNext = buildTimelineSections(legacyEntries, this.legacySections);
    this.legacySections = legacyNext;
    const projected = projectTimeline(snapshot, activeTurnId, this.cache);
    this.cache = projected.cache;
    expect(projected.entries).toEqual(legacyEntries);
    expect(projected.sections).toEqual(legacyNext);
    return this.cache;
  }

  /** A cold first build leaves an empty produced-registry, so the
   * chain's stable prefix is ~zero and any splice legitimately falls
   * back. Live sessions warm it with ordinary appends; mirror that so
   * the prepend steps below exercise the splice, not the fallback. */
  warm(items: ThreadItem[]): void {
    this.step([...items, cmd('twarm', 'cwarm')]);
    this.step(items);
  }
}

const user = (turnId: string, id: string, text = `问题 ${id}`): ThreadItem =>
  ({ turnId, type: 'userMessage', id, content: [{ type: 'text', text }] } as ThreadItem);
const agent = (turnId: string, id: string, text: string, phase: 'commentary' | 'final_answer' = 'commentary'): ThreadItem =>
  ({ turnId, type: 'agentMessage', id, phase, text } as ThreadItem);
const cmd = (turnId: string, id: string): ThreadItem =>
  ({ turnId, type: 'commandExecution', id, status: 'completed', command: 'npm test', aggregatedOutput: 'ok' } as ThreadItem);

function turnItems(turnId: string, size: number, tag: string): ThreadItem[] {
  const items: ThreadItem[] = [user(turnId, `${tag}-u`)];
  for (let i = 0; i < size - 2; i++) items.push(cmd(turnId, `${tag}-c${i}`));
  items.push(agent(turnId, `${tag}-a`, `结论 ${tag}`, 'final_answer'));
  return items;
}

describe('prepend equivalence', () => {
  it('matches across sequential whole-turn pages', () => {
    const oracle = new Oracle();
    let items: ThreadItem[] = [];
    for (let t = 40; t < 50; t++) items.push(...turnItems(`t${t}`, 40, `t${t}`));
    oracle.step(items);
    for (let page = 0; page < 5; page++) {
      const older: ThreadItem[] = [];
      for (let t = 40 - (page + 1) * 2; t < 40 - page * 2; t++) older.push(...turnItems(`t${t}`, 40, `t${t}`));
      items = [...older, ...items];
      oracle.step(items);
    }
  });

  it('matches when the page cuts the boundary turn mid-flight and moves the timing crown', () => {
    const oracle = new Oracle();
    // The window opens mid-turn: tb's user message and first response
    // segment are not loaded yet.
    let items: ThreadItem[] = [];
    for (let i = 20; i < 120; i++) items.push(cmd('tb', `cb-${i}`));
    items.push(agent('tb', 'ab', '边界轮的最终答复', 'final_answer'));
    items.push(...turnItems('tc', 30, 'tc'));
    oracle.step(items);
    oracle.warm(items);
    const before = oracle.step(items);
    const crownBefore = before.sections.find(section => section.turnId === 'tb' && section.showTiming);
    expect(crownBefore).toBeDefined();
    // The page carries tb's head: its user message, early commands and
    // a commentary — tb's first response now lives in the page.
    const page: ThreadItem[] = [user('tb', 'ub')];
    for (let i = 0; i < 20; i++) page.push(cmd('tb', `cb-${i}`));
    page.push(agent('tb', 'ab-early', '先导说明', 'commentary'));
    const grown = [...page, ...items];
    // The inserted commentary splits tb's commands; rebuild the item
    // list in true order: page head, commentary belongs after cb-19
    // which is where the page put it — order is already correct.
    const after = oracle.step(grown);
    const tbSections = after.sections.filter(section => section.turnId === 'tb' && !section.user);
    const crown = tbSections.find(section => section.showTiming);
    expect(crown).toBeDefined();
    expect(tbSections.filter(section => section.showTiming)).toHaveLength(1);
    expect(crown).not.toBe(crownBefore);
    // Turns away from the boundary keep their section objects.
    const tcBefore = before.sections.filter(section => section.turnId === 'tc');
    const tcAfter = after.sections.filter(section => section.turnId === 'tc');
    expect(tcAfter).toEqual(tcBefore);
    tcAfter.forEach((section, index) => expect(section).toBe(tcBefore[index]));
  });

  it('matches when the page ends on a steering message of the boundary turn', () => {
    const oracle = new Oracle();
    let items: ThreadItem[] = [];
    items.push(user('tb', 'ub'));
    for (let i = 10; i < 60; i++) items.push(cmd('tb', `cb-${i}`));
    items.push(agent('tb', 'ab', '最终答复', 'final_answer'));
    oracle.step(items);
    oracle.warm(items);
    const page: ThreadItem[] = [];
    for (let i = 0; i < 10; i++) page.push(cmd('tb', `cb-${i}`));
    page.push(user('tb', 'ub-steer', '插话：先停一下'));
    oracle.step([...page, ...items]);
  });

  it('matches a tail-trimmed prepend at the retention cap', () => {
    const oracle = new Oracle();
    let items: ThreadItem[] = [];
    for (let t = 0; t < 75; t++) items.push(...turnItems(`w${t}`, 40, `w${t}`));
    oracle.step(items);
    oracle.warm(items);
    const cache = oracle.step(items);
    // Choose a trim point the chain itself offers as an entry
    // checkpoint, deep into the window.
    const cp = cache.entryCheckpoints.filter(candidate => candidate.itemIndex > 2000).at(0)!;
    expect(cp).toBeDefined();
    const page: ThreadItem[] = [];
    for (let t = 0; t < 10; t++) page.push(...turnItems(`p${t}`, 40, `p${t}`));
    const trimmed = [...page, ...items.slice(0, cp.itemIndex)];
    const after = oracle.step(trimmed);
    expect(after.items).toHaveLength(trimmed.length);
  });

  it('matches a prepend onto a cache produced by streaming tail repairs', () => {
    const oracle = new Oracle();
    let items: ThreadItem[] = [...turnItems('s0', 60, 's0'), user('slive', 'ulive')];
    oracle.step(items, 'slive');
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 25; i++) items.push(cmd('slive', `cl-${round * 25 + i}`));
      oracle.step(items, 'slive');
      // In-place growth inside the tail turn (a command's output lands).
      const index = items.length - 3;
      items[index] = { ...items[index]!, aggregatedOutput: 'more' } as ThreadItem;
      oracle.step(items, 'slive');
    }
    const page: ThreadItem[] = [];
    for (let t = 0; t < 5; t++) page.push(...turnItems(`q${t}`, 40, `q${t}`));
    oracle.step([...page, ...items], 'slive');
    oracle.step([...page, ...items], null);
  });
});

describe('prepend path', () => {
  function fixture(totalTurns: number, tag: string): ThreadItem[] {
    const items: ThreadItem[] = [];
    for (let t = 0; t < totalTurns; t++) items.push(...turnItems(`${tag}${t}`, 40, `${tag}${t}`));
    return items;
  }

  it('splices the largest retained window instead of falling back to a full rebuild', () => {
    const page: ThreadItem[] = [];
    for (let t = 0; t < 10; t++) page.push(...turnItems(`pg${t}`, 40, `pg${t}`));
    const windowItems = fixture(125, 'b');  // ≈5,000 items
    // Warm the cache the way a live session does (an append step
    // after the cold first build) so the registry-stable prefix is
    // real; a cold cache legitimately falls back to the full build.
    const cold = projectTimeline(windowItems.slice(0, -40), null, null).cache;
    const base = projectTimeline(windowItems, null, cold).cache;
    const grown = projectTimeline([...page, ...windowItems], null, base);

    // The invariant is the path taken, not a wall-clock ratio. A
    // tight prepend/full ratio is shared-runner noise: PR #36 removed
    // a nearby scaling assertion after runners crossed it, and the
    // remaining prependMs < fullMs / 2 assertion later crossed by
    // ~3% (2.8129ms against a 2.7350ms bound) before Browser
    // Acceptance reached the browser assertions. The splice has
    // deterministic traces a full build does not reproduce:
    //
    // - the retained window's entries and sections survive as the
    //   verbatim suffix after the rescanned page, object for object;
    // - the output is produced under the base cache's own registries
    //   (the splice carries those exact Map objects forward; a full
    //   build scans under a freshly built registry even when its
    //   identity-reuse pass makes the output objects look alike);
    // - surviving entry checkpoints carry their snapshot arrays
    //   forward into translated coordinates (a full build snapshots
    //   fresh arrays everywhere).
    const pageProjection = projectTimeline(page, null, null);
    const entrySplice = grown.entries.indexOf(base.entries[0]!);
    expect(entrySplice).toBe(pageProjection.entries.length);
    expect(grown.entries).toHaveLength(entrySplice + base.entries.length);
    grown.entries.slice(entrySplice)
      .forEach((entry, index) => expect(entry).toBe(base.entries[index]));
    const sectionSplice = grown.sections.indexOf(base.sections[0]!);
    expect(sectionSplice).toBe(pageProjection.sections.length);
    expect(grown.sections).toHaveLength(sectionSplice + base.sections.length);
    grown.sections.slice(sectionSplice)
      .forEach((section, index) => expect(section).toBe(base.sections[index]));

    expect(grown.cache.producedActivityKeys).toBe(base.activityKeys);
    expect(grown.cache.producedPreviousByItem).toBe(base.previousByItem);
    const baseSnapshots = new Set(base.entryCheckpoints.map(cp => cp.activityItems));
    const carriedSnapshots = (cache: TimelineChainCache) =>
      cache.entryCheckpoints.filter(cp => baseSnapshots.has(cp.activityItems)).length;
    // Every checkpoint past the splice point is carried forward; the
    // splice checkpoint itself is consumed by the rescan.
    expect(carriedSnapshots(grown.cache)).toBe(base.entryCheckpoints.length - 1);

    // Negative control: clone the window's first item so reference
    // alignment breaks, detection misses, and the same call takes
    // the full build. None of the splice traces may appear there —
    // if they ever do, the assertions above have stopped guarding
    // the path and this control turns red instead.
    const broken = [...page, { ...windowItems[0] } as ThreadItem, ...windowItems.slice(1)];
    const fallback = projectTimeline(broken, null, base);
    expect(fallback.cache.producedActivityKeys).not.toBe(base.activityKeys);
    expect(fallback.cache.producedPreviousByItem).not.toBe(base.previousByItem);
    expect(carriedSnapshots(fallback.cache)).toBe(0);
  });
});
