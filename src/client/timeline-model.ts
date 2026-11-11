import type { ThreadItem } from './types';
import { itemKey } from './remote-state';
import { isSubagentItem } from './subagents';

export type TimelineEntry =
  | { type: 'message'; key: string; item: ThreadItem }
  | { type: 'event'; key: string; item: ThreadItem }
  | {
      type: 'activity';
      key: string;
      kind: ActivityKind;
      kinds: ActivityKind[];
      items: ThreadItem[];
      failedCount: number;
      declinedCount: number;
      running: boolean;
    };

export type ActivityKind = 'command' | 'file' | 'reasoning' | 'tool' | 'search' | 'image';

interface EntryScanState {
  activityItems: ThreadItem[];
  /** Global item index of activityItems[0], for entry start recording. */
  activityStart: number;
  responseTurnId: string | undefined;
  hasSubagentEntrance: boolean;
  retainedActivityKeys: Set<string>;
  /** Append-only mirror of retainedActivityKeys in insertion order;
   * checkpoints remember a length into this log instead of copying
   * the set. */
  retainedKeyLog: string[];
}

function createEntryScanState(): EntryScanState {
  return {
    activityItems: [], activityStart: 0, responseTurnId: undefined,
    hasSubagentEntrance: false, retainedActivityKeys: new Set(), retainedKeyLog: []
  };
}

function activityKeyRegistry(entries: TimelineEntry[]): Map<string, string> {
  const activityKeys = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === 'activity') for (const item of entry.items) activityKeys.set(itemKey(item), entry.key);
  }
  return activityKeys;
}

function flushActivityGroup(
  state: EntryScanState, activityKeys: Map<string, string>, activeTurnId: string | null,
  isLast: boolean, entries: TimelineEntry[], entryItemStarts: number[] | null
): void {
  const activityItems = state.activityItems;
  if (activityItems.length === 0) return;
  const failedCount = activityItems.filter((item) => 'status' in item && item.status === 'failed').length;
  const declinedCount = activityItems.filter((item) => 'status' in item && item.status === 'declined').length;
  const running = isLast && activeTurnId !== null && activityItems[0]!.turnId === activeTurnId &&
    activityItems[0]!.type !== 'imageView';
  const kindSet = new Set<ActivityKind>();
  for (const item of activityItems) {
    kindSet.add(activityKind(item)!);
    if (kindSet.size === 5) break;
  }
  const kinds = [...kindSet];
  const kind = (['tool', 'file', 'command', 'search', 'image'] as ActivityKind[]).find((kind) => kinds.includes(kind))!;
  const baseKey = `activity-${itemKey(activityItems[0]!)}`;
  let key = baseKey;
  for (const item of activityItems) {
    const candidate = activityKeys.get(itemKey(item));
    if (candidate && !state.retainedActivityKeys.has(candidate)) { key = candidate; break; }
  }
  let suffix = 1;
  while (state.retainedActivityKeys.has(key)) key = `${baseKey}-${++suffix}`;
  state.retainedActivityKeys.add(key);
  state.retainedKeyLog.push(key);
  entries.push({
    type: 'activity',
    key,
    kind,
    kinds,
    items: activityItems,
    failedCount,
    declinedCount,
    running
  });
  if (entryItemStarts) entryItemStarts.push(state.activityStart);
  state.activityItems = [];
}

/**
 * The sequential grouping scan behind buildTimelineEntries, factored out
 * so the incremental chain below can resume it from a checkpoint with an
 * exact snapshot of this state. `baseIndex` is the global item index of
 * items[0]; entry starts are recorded globally when `entryItemStarts` is
 * given. The scan does NOT flush the trailing activity group: callers
 * finish with flushActivityGroup(state, ..., isLast=true).
 */
function scanTimelineEntries(
  items: ThreadItem[], baseIndex: number, activeTurnId: string | null,
  activityKeys: Map<string, string>, state: EntryScanState,
  entries: TimelineEntry[], entryItemStarts: number[] | null,
  onItemProcessed?: (itemIndex: number) => void
): void {
  const flushActivity = (isLast = false) =>
    flushActivityGroup(state, activityKeys, activeTurnId, isLast, entries, entryItemStarts);

  items.forEach((item, offset) => {
    const index = baseIndex + offset;
    if (item.turnId !== state.responseTurnId || item.type === 'userMessage') {
      state.responseTurnId = item.turnId;
      state.hasSubagentEntrance = false;
    }
    if (item.type === 'reasoning' || item.type === 'imageGeneration') { onItemProcessed?.(index); return; }
    if (item.type === 'webSearch' && !item.query?.trim()) { onItemProcessed?.(index); return; }
    if (item.type === 'agentMessage' && !item.text.trim() && !item.questions?.length) { onItemProcessed?.(index); return; }
    if (state.activityItems.length > 0 && (item.turnId !== state.activityItems[0]!.turnId ||
      item.type === 'imageView' || state.activityItems[0]!.type === 'imageView')) flushActivity();
    if (isConversationItem(item)) {
      flushActivity();
      entries.push({
        type: 'message',
        key: `message-${itemKey(item)}`,
        item
      });
      if (entryItemStarts) entryItemStarts.push(index);
      onItemProcessed?.(index);
      return;
    }
    if (isSubagentItem(item)) {
      // ResponseSection renders all child updates at the first entrance. Later
      // updates keep their order for state projection but have no separate row.
      if (!state.hasSubagentEntrance) flushActivity();
      state.hasSubagentEntrance = true;
      entries.push({ type: 'event', key: `event-${itemKey(item)}`, item });
      if (entryItemStarts) entryItemStarts.push(index);
      onItemProcessed?.(index);
      return;
    }
    if (activityKind(item)) {
      if (state.activityItems.length === 0) state.activityStart = index;
      state.activityItems.push(item);
    } else {
      flushActivity();
      entries.push({ type: 'event', key: `event-${itemKey(item)}`, item });
      if (entryItemStarts) entryItemStarts.push(index);
    }
    onItemProcessed?.(index);
  });
}

function reuseEntryIdentity(entries: TimelineEntry[], previous: TimelineEntry[]): TimelineEntry[] {
  const previousByKey = new Map(previous.map(entry => [entry.key, entry]));
  return entries.map(entry => {
    const existing = previousByKey.get(entry.key);
    if (!existing) return entry;
    if (entry.type === 'activity' && existing.type === 'activity') {
      return entry.running === existing.running && entry.items.length === existing.items.length &&
        entry.items.every((item, index) => item === existing.items[index]) ? existing : entry;
    }
    return entry.type !== 'activity' && existing.type === entry.type && entry.item === existing.item ? existing : entry;
  });
}

export function buildTimelineEntries(
  items: ThreadItem[], activeTurnId: string | null = null, previous: TimelineEntry[] = []
): TimelineEntry[] {
  const activityKeys = activityKeyRegistry(previous);
  const state = createEntryScanState();
  const entries: TimelineEntry[] = [];
  scanTimelineEntries(items, 0, activeTurnId, activityKeys, state, entries, null);
  flushActivityGroup(state, activityKeys, activeTurnId, true, entries, null);
  return reuseEntryIdentity(entries, previous);
}

function activityKind(item: ThreadItem): ActivityKind | null {
  switch (item.type) {
    case 'commandExecution': return 'command';
    case 'fileChange': return 'file';
    case 'reasoning': return 'reasoning';
    case 'mcpToolCall':
    case 'dynamicToolCall': return 'tool';
    case 'webSearch': return 'search';
    case 'imageView': return 'image';
    default: return null;
  }
}

export function isConversationItem(item: ThreadItem): boolean {
  return item.type === 'userMessage' || item.type === 'agentMessage';
}

export function isActivityIssue(item: ThreadItem): boolean {
  return 'status' in item && (item.status === 'failed' || item.status === 'declined');
}

export interface TimelineSection {
  key: string;
  turnId: string | undefined;
  entries: TimelineEntry[];
  user: boolean;
  showTiming: boolean;
}

function sectionItemRegistry(sections: TimelineSection[]): Map<string, string> {
  const previousByItem = new Map<string, string>();
  for (const section of sections) {
    for (const entry of section.entries) {
      const items = entry.type === 'activity' ? entry.items : [entry.item];
      for (const item of items) previousByItem.set(itemKey(item), section.key);
    }
  }
  return previousByItem;
}

/**
 * The grouping scan behind buildTimelineSections, factored out so the
 * incremental chain can resume it at a section boundary. Appends to
 * `sections` and registers first responses into `firstResponse`;
 * showTiming, key retention and identity reuse are separate passes.
 * `onSectionStart` fires (with the global entry index) right before a
 * new section is pushed, when every section so far is closed.
 */
function scanTimelineSections(
  entries: TimelineEntry[], baseIndex: number,
  sections: TimelineSection[], firstResponse: Map<string, TimelineSection>,
  onSectionStart?: (entryIndex: number) => void,
  firstResponseLog?: Array<readonly [string, TimelineSection]>
): void {
  entries.forEach((entry, offset) => {
    const item = entry.type === 'activity' ? entry.items[0]! : entry.item;
    const user = item.type === 'userMessage';
    let section = sections.at(-1);
    if (!section || user || section.user || section.turnId !== item.turnId) {
      if (section) onSectionStart?.(baseIndex + offset);
      section = { key: entry.key, turnId: item.turnId, entries: [], user, showTiming: false };
      sections.push(section);
    }
    section.entries.push(entry);
    if (!user && item.turnId && !firstResponse.has(item.turnId)) {
      firstResponse.set(item.turnId, section);
      firstResponseLog?.push([item.turnId, section]);
    }
  });
}

function retainSectionKeys(
  sections: TimelineSection[], previousByItem: Map<string, string>, retained: Set<string>
): void {
  // A page can begin inside a response. Keep its identity when its prefix arrives.
  for (const section of sections) {
    let key: string | undefined;
    outer: for (const entry of section.entries) {
      const entryItems = entry.type === 'activity' ? entry.items : [entry.item];
      for (const item of entryItems) {
        const candidate = previousByItem.get(itemKey(item));
        if (candidate && !retained.has(candidate)) { key = candidate; break outer; }
      }
    }
    if (key) section.key = key;
    retained.add(section.key);
  }
}

function reuseSectionIdentity(sections: TimelineSection[], previous: TimelineSection[]): TimelineSection[] {
  const previousByKey = new Map(previous.map(section => [section.key, section]));
  return sections.map(section => {
    const existing = previousByKey.get(section.key);
    return existing && existing.showTiming === section.showTiming && existing.entries.length === section.entries.length &&
      existing.entries.every((entry, index) => entry === section.entries[index]) ? existing : section;
  });
}

export function buildTimelineSections(entries: TimelineEntry[], previous: TimelineSection[] = []): TimelineSection[] {
  const sections: TimelineSection[] = [];
  const firstResponse = new Map<string, TimelineSection>();
  scanTimelineSections(entries, 0, sections, firstResponse);
  for (const section of firstResponse.values()) section.showTiming = true;
  retainSectionKeys(sections, sectionItemRegistry(previous), new Set());
  return reuseSectionIdentity(sections, previous);
}

/**
 * Incremental timeline chain.
 *
 * Profiling (2,431–5,090 retained items) put the entries+sections chain
 * at roughly 3–8ms per streaming flush on an unthrottled core — small in
 * isolation, but at a 60ms flush cadence under CPU throttling it is a
 * visible share of every frame budget. The chain therefore resumes from
 * exact scan checkpoints when the change is confined to the tail:
 *
 * - Entry checkpoints snapshot the grouping scan's full state (pending
 *   activity included) every 256 items and at clean points, so a resume
 *   rescans only the items after the last checkpoint at or before the
 *   first divergent item.
 * - Section checkpoints snapshot at every section start (when all prior
 *   sections are closed), so sections resume the same way.
 * - A history prepend (an older page in front of the window, with or
 *   without a tail trim at the retention cap) is spliced symmetrically
 *   at the head: only the page and the boundary turn are rescanned,
 *   the remaining turns keep their entries, sections and identities.
 * - ANY other shape — a changed head, a shrink, a divergence before the
 *   last usable checkpoint — falls back to the full builders above,
 *   whose output the chain's full path shares verbatim. The public
 *   builders remain the reference semantics; the equivalence tests pin
 *   the chain to them.
 *
 * The cache is treated as immutable: every call returns a fresh cache,
 * so a discarded render can never corrupt the stored one.
 */
const TIMELINE_CHECKPOINT_ITEMS = 256;
const TIMELINE_CHECKPOINT_CLEAN_ITEMS = 32;

interface EntryCheckpoint {
  itemIndex: number;
  entriesLength: number;
  activityItems: ThreadItem[];
  activityStart: number;
  responseTurnId: string | undefined;
  hasSubagentEntrance: boolean;
  retainedCount: number;
}

interface SectionCheckpoint {
  entryIndex: number;
  sectionsLength: number;
  firstResponseCount: number;
}

export interface TimelineChainCache {
  items: ThreadItem[];
  activeTurnId: string | null;
  entries: TimelineEntry[];
  sections: TimelineSection[];
  entryItemStarts: number[];
  entryCheckpoints: EntryCheckpoint[];
  sectionCheckpoints: SectionCheckpoint[];
  /** Item -> activity entry key, built from `entries`. */
  activityKeys: Map<string, string>;
  /** Item -> section key, built from `sections`. */
  previousByItem: Map<string, string>;
  /**
   * The registries this cache's output was produced under. Key
   * retention is a cross-build function: a later registry can rekey an
   * earlier group even when its items never changed (a reorder that
   * changes which entry a shared item maps to is enough). A checkpoint
   * resume is therefore only sound for the leading entries/sections
   * whose items both registries still agree on — `stableEntries` and
   * `stableSections` count exactly those.
   */
  producedActivityKeys: Map<string, string>;
  producedPreviousByItem: Map<string, string>;
  stableEntries: number;
  stableSections: number;
  /** Insertion-ordered retained activity keys of the latest build;
   * entry checkpoints index into it by `retainedCount`. */
  retainedKeyLog: string[];
  /** Registration-ordered [turnId, section] pairs of the latest
   * build; section checkpoints index into it by
   * `firstResponseCount`, and its values are the final (identity
   * reused) section objects. */
  firstResponseLog: Array<readonly [string, TimelineSection]>;
}

/**
 * Count the leading units whose items the produced-under registry and
 * the current registry agree on; the first disagreement ends the stable
 * prefix. `itemsOf` returns null for units that never consult the
 * registry (message/event entries).
 */
function registryAgreementBoundary<T>(
  units: T[], produced: Map<string, string>, current: Map<string, string>,
  itemsOf: (unit: T) => ThreadItem[] | null
): number {
  for (let index = 0; index < units.length; index++) {
    const unitItems = itemsOf(units[index]!);
    if (!unitItems) continue;
    for (const item of unitItems) {
      const key = itemKey(item);
      if (produced.get(key) !== current.get(key)) return index;
    }
  }
  return units.length;
}

function entryStability(
  entries: TimelineEntry[], produced: Map<string, string>, current: Map<string, string>
): number {
  return registryAgreementBoundary(entries, produced, current,
    entry => entry.type === 'activity' ? entry.items : null);
}

function sectionStability(
  sections: TimelineSection[], produced: Map<string, string>, current: Map<string, string>
): number {
  return registryAgreementBoundary(sections, produced, current,
    section => section.entries.flatMap(entry => entry.type === 'activity' ? entry.items : [entry.item]));
}

export interface TimelineProjection {
  entries: TimelineEntry[];
  sections: TimelineSection[];
  cache: TimelineChainCache;
}

function snapshotEntryCheckpoint(
  state: EntryScanState, itemIndex: number, entriesLength: number
): EntryCheckpoint {
  return {
    itemIndex, entriesLength,
    activityItems: state.activityItems.slice(), activityStart: state.activityStart,
    responseTurnId: state.responseTurnId, hasSubagentEntrance: state.hasSubagentEntrance,
    retainedCount: state.retainedKeyLog.length
  };
}

function remapFirstResponseLog(
  log: Array<readonly [string, TimelineSection]>, scanned: TimelineSection[], final: TimelineSection[]
): Array<readonly [string, TimelineSection]> {
  if (log.length === 0) return log;
  const remapped = new Map<TimelineSection, TimelineSection>();
  scanned.forEach((section, index) => { if (final[index]) remapped.set(section, final[index]!); });
  return log.map(([turnId, section]) => [turnId, remapped.get(section) ?? section] as const);
}

function buildChainFull(
  items: ThreadItem[], activeTurnId: string | null,
  previous: { entries: TimelineEntry[]; sections: TimelineSection[] } | null
): TimelineChainCache {
  const scanRegistry = activityKeyRegistry(previous?.entries ?? []);
  const state = createEntryScanState();
  const entries: TimelineEntry[] = [];
  const entryItemStarts: number[] = [];
  const entryCheckpoints: EntryCheckpoint[] = [];
  let lastCheckpointAt = 0;
  scanTimelineEntries(items, 0, activeTurnId, scanRegistry, state, entries, entryItemStarts, processed => {
    const next = processed + 1;
    if (next - lastCheckpointAt >= TIMELINE_CHECKPOINT_ITEMS ||
        (state.activityItems.length === 0 && next - lastCheckpointAt >= TIMELINE_CHECKPOINT_CLEAN_ITEMS)) {
      entryCheckpoints.push(snapshotEntryCheckpoint(state, next, entries.length));
      lastCheckpointAt = next;
    }
  });
  flushActivityGroup(state, scanRegistry, activeTurnId, true, entries, entryItemStarts);
  const finalEntries = reuseEntryIdentity(entries, previous?.entries ?? []);

  const sections: TimelineSection[] = [];
  const firstResponse = new Map<string, TimelineSection>();
  const firstResponseLog: Array<readonly [string, TimelineSection]> = [];
  const sectionCheckpoints: SectionCheckpoint[] = [];
  scanTimelineSections(finalEntries, 0, sections, firstResponse, entryIndex => {
    sectionCheckpoints.push({
      entryIndex, sectionsLength: sections.length, firstResponseCount: firstResponseLog.length
    });
  }, firstResponseLog);
  for (const section of firstResponse.values()) section.showTiming = true;
  const producedPreviousByItem = sectionItemRegistry(previous?.sections ?? []);
  retainSectionKeys(sections, producedPreviousByItem, new Set());
  const finalSections = reuseSectionIdentity(sections, previous?.sections ?? []);

  const activityKeys = activityKeyRegistry(finalEntries);
  const previousByItem = sectionItemRegistry(finalSections);
  return {
    items, activeTurnId, entries: finalEntries, sections: finalSections, entryItemStarts,
    entryCheckpoints,
    sectionCheckpoints,
    firstResponseLog: remapFirstResponseLog(firstResponseLog, sections, finalSections),
    retainedKeyLog: state.retainedKeyLog,
    activityKeys, previousByItem,
    producedActivityKeys: scanRegistry, producedPreviousByItem,
    stableEntries: entryStability(finalEntries, scanRegistry, activityKeys),
    stableSections: sectionStability(finalSections, producedPreviousByItem, previousByItem)
  };
}

// --- Repair the registries to describe the new output ---
// Pair each discarded unit with the rebuilt unit of the same key:
// unchanged pairs need no writes at all, and changed pairs only
// touch the items that actually moved (compared by reference), so a
// streaming tail update costs proportionally to the change rather
// than to the size of the trailing group. The map is copied lazily,
// only when a write actually happens.
function repairRegistry(
  source: Map<string, string>,
  discarded: Array<{ key: string; items: ThreadItem[] }>,
  rebuilt: Array<{ key: string; items: ThreadItem[] }>
): { map: Map<string, string>; changedKeys: Set<string> } {
  let result = source;
  const writable = () => {
    if (result === source) result = new Map(source);
    return result;
  };
  const rebuiltByKey = new Map(rebuilt.map(unit => [unit.key, unit]));
  const consumed = new Set<string>();
  const changedKeys = new Set<string>();
  for (const unit of discarded) {
    const pair = rebuiltByKey.get(unit.key);
    if (pair && !consumed.has(pair.key)) {
      consumed.add(pair.key);
      if (pair.items.length === unit.items.length &&
          pair.items.every((item, index) => item === unit.items[index])) continue;
      const pairItems = new Set(pair.items);
      const unitItems = new Set(unit.items);
      for (const item of unit.items) {
        const key = itemKey(item);
        if (!pairItems.has(item) && result.get(key) === unit.key) { writable().delete(key); changedKeys.add(key); }
      }
      for (const item of pair.items) {
        const key = itemKey(item);
        if (!unitItems.has(item) && result.get(key) !== pair.key) { writable().set(key, pair.key); changedKeys.add(key); }
      }
    } else {
      for (const item of unit.items) {
        const key = itemKey(item);
        if (result.get(key) === unit.key) { writable().delete(key); changedKeys.add(key); }
      }
    }
  }
  for (const unit of rebuilt) {
    if (consumed.has(unit.key)) continue;
    for (const item of unit.items) {
      const key = itemKey(item);
      if (result.get(key) !== unit.key) { writable().set(key, unit.key); changedKeys.add(key); }
    }
  }
  return { map: result, changedKeys };
}
function activityUnits(list: TimelineEntry[]): Array<{ key: string; items: ThreadItem[] }> {
  return list.flatMap(entry =>
    entry.type === 'activity' ? [{ key: entry.key, items: entry.items }] : []);
}
function sectionUnits(list: TimelineSection[]): Array<{ key: string; items: ThreadItem[] }> {
  return list.map(section => ({
    key: section.key,
    items: section.entries.flatMap(entry => entry.type === 'activity' ? entry.items : [entry.item])
  }));
}
// Stability of the new output under the registries it was produced
// with: only items the repair actually rewrote can disagree, and
// every rewritten item lives in a rebuilt unit — or, when the same
// item also appears in a kept prefix unit, in that unit. So the
// boundary is the first prefix unit holding a rewritten item, else
// the resume point itself; no rewrites means full agreement.
function stabilityBoundary<T>(
  units: T[], changedKeys: Set<string>, resumePoint: number,
  itemsOf: (unit: T) => ThreadItem[] | null
): number {
  if (changedKeys.size === 0) return units.length;
  const prefixLimit = Math.min(resumePoint, units.length);
  for (let index = 0; index < prefixLimit; index++) {
    const unitItems = itemsOf(units[index]!);
    if (!unitItems) continue;
    for (const item of unitItems) if (changedKeys.has(itemKey(item))) return index;
  }
  return prefixLimit;
}


/**
 * Detect the history-prepend shape: the new snapshot is an older page
 * in front of (a prefix of) the cached window. Returns the page size
 * (`prefix`) and how many leading cached items survive (`aligned`); a
 * tail trim at the retention cap makes aligned < cache length.
 * Detection is reference-based and rejects the streaming shapes in
 * O(1): an append's first probe compares a mid-window item against
 * the cached head and misses immediately.
 */
function detectPrepend(
  items: ThreadItem[], cache: TimelineChainCache
): { prefix: number; aligned: number } | null {
  const old = cache.items;
  const run = (offset: number): number => {
    let count = 0;
    const limit = Math.min(old.length, items.length - offset);
    while (count < limit && items[offset + count] === old[count]) count++;
    return count;
  };
  const delta = items.length - old.length;
  if (delta >= 1) {
    // The window grew, so no tail trim is possible: the page is exact.
    return run(delta) === old.length ? { prefix: delta, aligned: old.length } : null;
  }
  // Tail-trimmed prepend: the window sat at its retention cap, so the
  // page pushed an equal number of newest items out the other side.
  // Page sizes are bounded (a few hundred items); require a
  // substantial aligned remainder so the scan stays worthwhile and
  // the search stays a handful of reference compares per call.
  const maxPrefix = Math.min(1024, items.length - 1024);
  for (let prefix = 1; prefix <= maxPrefix; prefix++) {
    if (items[prefix] !== old[0]) continue;
    if (run(prefix) === items.length - prefix) return { prefix, aligned: items.length - prefix };
  }
  return null;
}

/**
 * The prepend counterpart of the tail resume in projectTimeline: a
 * history page lands in front of the window, so the scan is redone
 * only over the page plus the old items up to the first clean entry
 * checkpoint whose scan state the rescan reproduces exactly; every
 * entry and section after the splice is reused verbatim (object
 * identity included), with a single showTiming repair for the one
 * turn that can span the section splice. The boundary turn a page
 * cuts through is rebuilt; all other turns keep their entries,
 * sections, keys and measurements. Soundness conditions, each
 * verified before splicing:
 *
 * - the splice checkpoint sits inside the registry-stable prefix, so
 *   the rescan region reproduces under the current registries;
 * - the kept suffix reproduces under the current registries because
 *   the chain's registries are self-referential: activityKeys is
 *   always exactly the registry of the cache's own entries, so a
 *   full build scanning with it finds every kept group's own key as
 *   the first unretained candidate and re-derives it verbatim (the
 *   retained-key namespaces of page and window are disjoint — keys
 *   embed their first item's key — so the page's retentions can
 *   never shadow a kept group's candidate);
 * - a tail trim must land exactly on an entry checkpoint and the
 *   matching section checkpoint, so kept units end on boundaries.
 *
 * Returns null when any condition fails; the caller falls back to
 * the full build, whose output this path is pinned to by the chain
 * equivalence tests (prepend steps included).
 */
function buildChainPrepend(
  items: ThreadItem[], activeTurnId: string | null, cache: TimelineChainCache,
  prefix: number, aligned: number
): TimelineChainCache | null {
  // Ends of the kept region in old coordinates.
  let alignedEntryEnd = cache.entries.length;
  let alignedSectionEnd = cache.sections.length;
  let alignedFirstResponseCount = cache.firstResponseLog.length;
  let alignedRetainedCount = cache.retainedKeyLog.length;
  if (aligned < cache.items.length) {
    const entryCp = cache.entryCheckpoints.find(cp => cp.itemIndex === aligned);
    if (!entryCp) return null;
    alignedEntryEnd = entryCp.entriesLength;
    alignedRetainedCount = entryCp.retainedCount;
    const sectionCp = cache.sectionCheckpoints.find(cp => cp.entryIndex === alignedEntryEnd);
    if (!sectionCp) return null;
    alignedSectionEnd = sectionCp.sectionsLength;
    alignedFirstResponseCount = sectionCp.firstResponseCount;
  }
  const candidates = cache.entryCheckpoints.filter(cp =>
    cp.activityItems.length === 0 && cp.itemIndex >= 1 && cp.itemIndex <= aligned &&
    cp.entriesLength <= cache.stableEntries && cp.entriesLength <= alignedEntryEnd);
  // --- Rescan the page plus old items up to a splice checkpoint ---
  const state = createEntryScanState();
  const headEntries: TimelineEntry[] = [];
  const headEntryStarts: number[] = [];
  const headCheckpoints: EntryCheckpoint[] = [];
  let lastCheckpointAt = 0;
  let scannedTo = 0;
  let chosen: EntryCheckpoint | null = null;
  const recordCheckpoint = (processed: number) => {
    const next = processed + 1;
    if (next - lastCheckpointAt >= TIMELINE_CHECKPOINT_ITEMS ||
        (state.activityItems.length === 0 && next - lastCheckpointAt >= TIMELINE_CHECKPOINT_CLEAN_ITEMS)) {
      headCheckpoints.push(snapshotEntryCheckpoint(state, next, headEntries.length));
      lastCheckpointAt = next;
    }
  };
  for (const candidate of candidates) {
    const target = prefix + candidate.itemIndex;
    if (target > scannedTo) {
      scanTimelineEntries(items.slice(scannedTo, target), scannedTo, activeTurnId,
        cache.activityKeys, state, headEntries, headEntryStarts, recordCheckpoint);
      scannedTo = target;
    }
    if (state.activityItems.length === 0 &&
        state.responseTurnId === candidate.responseTurnId &&
        state.hasSubagentEntrance === candidate.hasSubagentEntrance) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) return null;

  // --- Entries: rescanned head + verbatim kept suffix ---
  const headFinal = reuseEntryIdentity(headEntries, cache.entries.slice(0, chosen.entriesLength));
  const keptEntries = cache.entries.slice(chosen.entriesLength, alignedEntryEnd);
  const finalEntries = [...headFinal, ...keptEntries];
  const entryItemStarts = [...headEntryStarts,
    ...cache.entryItemStarts.slice(chosen.entriesLength, alignedEntryEnd).map(start => start + prefix)];

  // --- Sections: rescan up to a section splice, keep the rest ---
  const sectionSplice = cache.sectionCheckpoints.find(cp =>
    cp.entryIndex >= chosen.entriesLength && cp.entryIndex <= alignedEntryEnd);
  if (!sectionSplice) return null;
  const finalEntrySplice = headFinal.length + (sectionSplice.entryIndex - chosen.entriesLength);
  const scannedSections: TimelineSection[] = [];
  const firstResponse = new Map<string, TimelineSection>();
  const scannedLog: Array<readonly [string, TimelineSection]> = [];
  const scannedCheckpoints: SectionCheckpoint[] = [];
  scanTimelineSections(finalEntries.slice(0, finalEntrySplice), 0, scannedSections, firstResponse,
    entryIndex => {
      scannedCheckpoints.push({ entryIndex, sectionsLength: scannedSections.length,
        firstResponseCount: scannedLog.length });
    }, scannedLog);
  for (const section of firstResponse.values()) section.showTiming = true;
  retainSectionKeys(scannedSections, cache.previousByItem, new Set());
  const scannedFinal = reuseSectionIdentity(scannedSections,
    cache.sections.slice(0, sectionSplice.sectionsLength));
  const finalLogHead = remapFirstResponseLog(scannedLog, scannedSections, scannedFinal);
  // Kept sections keep their flags, except the one turn that can span
  // the splice: if the rescan registered its first response earlier
  // than the kept copy the old build crowned, the crown moves.
  const keptRaw = cache.sections.slice(sectionSplice.sectionsLength, alignedSectionEnd);
  const finalFirstResponse = new Map<string, TimelineSection>([...finalLogHead,
    ...cache.firstResponseLog.slice(sectionSplice.firstResponseCount, alignedFirstResponseCount)]);
  const keptSubstitutions = new Map<TimelineSection, TimelineSection>();
  const keptSections = keptRaw.map(section => {
    const desired = section.turnId !== undefined && finalFirstResponse.get(section.turnId) === section;
    if (section.showTiming === desired) return section;
    const clone = { ...section, showTiming: desired };
    keptSubstitutions.set(section, clone);
    return clone;
  });
  const finalLog = [...finalLogHead,
    ...cache.firstResponseLog.slice(sectionSplice.firstResponseCount, alignedFirstResponseCount)
      .map(([turnId, section]) => [turnId, keptSubstitutions.get(section) ?? section] as const)];
  const finalSections = [...scannedFinal, ...keptSections];

  // --- Translate the surviving checkpoints into new coordinates ---
  const entryCheckpoints = [...headCheckpoints];
  for (const cp of cache.entryCheckpoints) {
    if (cp.itemIndex <= chosen.itemIndex || cp.itemIndex > aligned) continue;
    entryCheckpoints.push({
      itemIndex: cp.itemIndex + prefix,
      entriesLength: headFinal.length + (cp.entriesLength - chosen.entriesLength),
      activityItems: cp.activityItems,
      activityStart: cp.activityStart + prefix,
      responseTurnId: cp.responseTurnId,
      hasSubagentEntrance: cp.hasSubagentEntrance,
      retainedCount: state.retainedKeyLog.length + (cp.retainedCount - chosen.retainedCount)
    });
  }
  const sectionCheckpoints = [...scannedCheckpoints, {
    entryIndex: finalEntrySplice, sectionsLength: scannedFinal.length,
    firstResponseCount: finalLogHead.length
  }];
  for (const cp of cache.sectionCheckpoints) {
    if (cp.entryIndex <= sectionSplice.entryIndex || cp.entryIndex > alignedEntryEnd) continue;
    sectionCheckpoints.push({
      entryIndex: finalEntrySplice + (cp.entryIndex - sectionSplice.entryIndex),
      sectionsLength: scannedFinal.length + (cp.sectionsLength - sectionSplice.sectionsLength),
      firstResponseCount: finalLogHead.length + (cp.firstResponseCount - sectionSplice.firstResponseCount)
    });
  }
  const retainedKeyLog = [...state.retainedKeyLog,
    ...cache.retainedKeyLog.slice(chosen.retainedCount, alignedRetainedCount)];

  // --- Repair the registries over the rebuilt head units only ---
  const entryRepair = repairRegistry(cache.activityKeys,
    [...activityUnits(cache.entries.slice(0, chosen.entriesLength)),
      ...activityUnits(cache.entries.slice(alignedEntryEnd))],
    activityUnits(headFinal));
  const sectionRepair = repairRegistry(cache.previousByItem,
    [...sectionUnits(cache.sections.slice(0, sectionSplice.sectionsLength)),
      ...sectionUnits(cache.sections.slice(alignedSectionEnd))],
    sectionUnits(scannedFinal));

  return {
    items, activeTurnId, entries: finalEntries, sections: finalSections, entryItemStarts,
    entryCheckpoints, sectionCheckpoints,
    firstResponseLog: finalLog,
    retainedKeyLog,
    activityKeys: entryRepair.map, previousByItem: sectionRepair.map,
    producedActivityKeys: cache.activityKeys, producedPreviousByItem: cache.previousByItem,
    stableEntries: stabilityBoundary(finalEntries, entryRepair.changedKeys, headFinal.length,
      entry => entry.type === 'activity' ? entry.items : null),
    stableSections: stabilityBoundary(finalSections, sectionRepair.changedKeys, scannedFinal.length,
      section => section.entries.flatMap(entry => entry.type === 'activity' ? entry.items : [entry.item]))
  };
}

export function projectTimeline(
  items: ThreadItem[], activeTurnId: string | null, cache: TimelineChainCache | null
): TimelineProjection {
  const full = (): TimelineProjection => {
    const built = buildChainFull(items, activeTurnId,
      cache ? { entries: cache.entries, sections: cache.sections } : null);
    return { entries: built.entries, sections: built.sections, cache: built };
  };
  if (!cache) return full();
  if (items === cache.items && activeTurnId === cache.activeTurnId) {
    return { entries: cache.entries, sections: cache.sections, cache };
  }
  // History prepends diverge at index 0 by construction, so they must
  // be detected before the divergence logic sends them to the full
  // build: the prepend path rescans only the page and the boundary
  // turn and reuses the whole remaining window verbatim.
  if (activeTurnId === cache.activeTurnId) {
    const prepend = detectPrepend(items, cache);
    if (prepend) {
      const built = buildChainPrepend(items, activeTurnId, cache, prepend.prefix, prepend.aligned);
      if (built) return { entries: built.entries, sections: built.sections, cache: built };
    }
  }
  if (items.length < cache.items.length) return full();
  let divergence = 0;
  const limit = Math.min(cache.items.length, items.length);
  while (divergence < limit && cache.items[divergence] === items[divergence]) divergence++;
  if (divergence === 0) return full();
  if (divergence === cache.items.length && items.length === cache.items.length &&
      activeTurnId === cache.activeTurnId) {
    return { entries: cache.entries, sections: cache.sections, cache };
  }
  // A changed active turn can only flip the trailing activity group's
  // running flag; force the resume point to at most that group's start.
  let target = divergence;
  if (activeTurnId !== cache.activeTurnId) {
    target = Math.min(target, cache.entryItemStarts.at(-1) ?? 0);
  }
  // The resume point must also sit inside the registry-stable prefix:
  // beyond it, a full rescan could rekey a kept group purely because
  // the registry moved since that group was produced.
  let entryCheckpoint: EntryCheckpoint | null = null;
  for (let index = cache.entryCheckpoints.length - 1; index >= 0; index--) {
    const candidate = cache.entryCheckpoints[index]!;
    if (candidate.itemIndex <= target && candidate.entriesLength <= cache.stableEntries) {
      entryCheckpoint = candidate;
      break;
    }
  }
  if (!entryCheckpoint || entryCheckpoint.itemIndex === 0) return full();

  // --- Resume the entries scan from the checkpoint ---
  const retainedLogPrefix = cache.retainedKeyLog.slice(0, entryCheckpoint.retainedCount);
  const entryState: EntryScanState = {
    activityItems: entryCheckpoint.activityItems.slice(), activityStart: entryCheckpoint.activityStart,
    responseTurnId: entryCheckpoint.responseTurnId, hasSubagentEntrance: entryCheckpoint.hasSubagentEntrance,
    retainedActivityKeys: new Set(retainedLogPrefix), retainedKeyLog: retainedLogPrefix
  };
  const entries = cache.entries.slice(0, entryCheckpoint.entriesLength);
  const entryItemStarts = cache.entryItemStarts.slice(0, entryCheckpoint.entriesLength);
  const entryCheckpoints = cache.entryCheckpoints.filter(cp => cp.itemIndex <= entryCheckpoint!.itemIndex);
  let lastCheckpointAt = entryCheckpoint.itemIndex;
  scanTimelineEntries(items.slice(entryCheckpoint.itemIndex), entryCheckpoint.itemIndex,
    activeTurnId, cache.activityKeys, entryState, entries, entryItemStarts, processed => {
      const next = processed + 1;
      if (next - lastCheckpointAt >= TIMELINE_CHECKPOINT_ITEMS ||
          (entryState.activityItems.length === 0 && next - lastCheckpointAt >= TIMELINE_CHECKPOINT_CLEAN_ITEMS)) {
        entryCheckpoints.push(snapshotEntryCheckpoint(entryState, next, entries.length));
        lastCheckpointAt = next;
      }
    });
  flushActivityGroup(entryState, cache.activityKeys, activeTurnId, true, entries, entryItemStarts);
  const finalEntries = [...entries.slice(0, entryCheckpoint.entriesLength),
    ...reuseEntryIdentity(entries.slice(entryCheckpoint.entriesLength), cache.entries)];

  // --- Resume the sections scan from its checkpoint ---
  let sectionCheckpoint: SectionCheckpoint | null = null;
  for (let index = cache.sectionCheckpoints.length - 1; index >= 0; index--) {
    const candidate = cache.sectionCheckpoints[index]!;
    if (candidate.entryIndex <= entryCheckpoint.entriesLength &&
        candidate.sectionsLength <= cache.stableSections) {
      sectionCheckpoint = candidate;
      break;
    }
  }
  const sectionsPrefixLength = sectionCheckpoint?.sectionsLength ?? 0;
  const sections = cache.sections.slice(0, sectionsPrefixLength);
  if (sections.length > 0) {
    // The scan may keep appending to the last (closed) prefix section if
    // the first rebuilt entry continues it; never mutate the cached one.
    const last = sections[sections.length - 1]!;
    sections[sections.length - 1] = { ...last, entries: [...last.entries] };
  }
  const firstResponseLog = cache.firstResponseLog.slice(0, sectionCheckpoint?.firstResponseCount ?? 0);
  const firstResponse = new Map<string, TimelineSection>(firstResponseLog);
  const sectionCheckpoints = cache.sectionCheckpoints
    .filter(cp => cp.entryIndex <= (sectionCheckpoint?.entryIndex ?? 0));
  scanTimelineSections(finalEntries.slice(sectionCheckpoint?.entryIndex ?? 0),
    sectionCheckpoint?.entryIndex ?? 0, sections, firstResponse, entryIndex => {
      sectionCheckpoints.push({
        entryIndex, sectionsLength: sections.length, firstResponseCount: firstResponseLog.length
      });
    }, firstResponseLog);
  for (const section of firstResponse.values()) section.showTiming = true;
  const retentionStart = sectionsPrefixLength > 0 ? sectionsPrefixLength - 1 : 0;
  const retained = new Set(sections.slice(0, retentionStart).map(section => section.key));
  const suffixSections = sections.slice(retentionStart);
  retainSectionKeys(suffixSections, cache.previousByItem, retained);
  const finalSections = [...sections.slice(0, retentionStart),
    ...reuseSectionIdentity(suffixSections, cache.sections)];

  const entryRepair = repairRegistry(cache.activityKeys,
    activityUnits(cache.entries.slice(entryCheckpoint.entriesLength)),
    activityUnits(finalEntries.slice(entryCheckpoint.entriesLength)));
  const sectionRepair = repairRegistry(cache.previousByItem,
    sectionUnits(cache.sections.slice(retentionStart)),
    sectionUnits(finalSections.slice(retentionStart)));
  const activityKeys = entryRepair.map;
  const previousByItem = sectionRepair.map;
  const built: TimelineChainCache = {
    items, activeTurnId, entries: finalEntries, sections: finalSections, entryItemStarts,
    entryCheckpoints,
    sectionCheckpoints,
    firstResponseLog: remapFirstResponseLog(firstResponseLog, sections, finalSections),
    retainedKeyLog: entryState.retainedKeyLog,
    activityKeys, previousByItem,
    // The whole output is reproducible under the registries this
    // resume scanned with: the kept prefix is inside the stable region
    // (so those registries reproduce it too), the suffix used them
    // directly.
    producedActivityKeys: cache.activityKeys, producedPreviousByItem: cache.previousByItem,
    stableEntries: stabilityBoundary(finalEntries, entryRepair.changedKeys,
      entryCheckpoint.entriesLength, entry => entry.type === 'activity' ? entry.items : null),
    stableSections: stabilityBoundary(finalSections, sectionRepair.changedKeys, retentionStart,
      section => section.entries.flatMap(entry => entry.type === 'activity' ? entry.items : [entry.item]))
  };
  return { entries: finalEntries, sections: finalSections, cache: built };
}

export function finalAnswerIndex(entries: TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === 'message' && entry.item.type === 'agentMessage' &&
      entry.item.phase !== 'commentary' && entry.item.phase !== 'partial_answer' &&
      entry.item.text.trim()) return index;
  }
  return -1;
}

export interface TimelineTurnResponse {
  finalStartedAtMs: number | null;
  hasTrace: boolean;
  lastResponseKey: string;
  finalAnswer?: ThreadItem;
}

export function timelineTurnResponses(sections: TimelineSection[], truncatedTailTurnId?: string | null) {
  const turns = new Map<string, TimelineTurnResponse>();
  for (const section of sections) {
    if (section.user || !section.turnId) continue;
    const turn = turns.get(section.turnId) ?? { finalStartedAtMs: null, hasTrace: false, lastResponseKey: section.key };
    const finalIndex = finalAnswerIndex(section.entries);
    const final = section.entries[finalIndex];
    if (final?.type === 'message') {
      // A turn cut by the newer window boundary may continue past the
      // retained items. Its last loaded slice is not the final answer, so
      // its start must not anchor the work duration; the caller falls back
      // to the native turn timing instead of showing a transient slice age.
      turn.finalStartedAtMs = section.turnId === truncatedTailTurnId ? null : final.item.startedAtMs ?? null;
      turn.finalAnswer = final.item;
    }
    turn.hasTrace ||= (finalIndex < 0 ? section.entries.length : finalIndex) > 0;
    turn.lastResponseKey = section.key;
    turns.set(section.turnId, turn);
  }
  return turns;
}

/**
 * A settled turn's final answer never changes, so once its start has been
 * observed inside the window the divider must not fall back to the native
 * duration just because the reader scrolled the answer out of the window
 * again (the observed 4h18m <-> 4h03m flip on long turns). `remembered` is
 * the caller's per-thread anchor memory: anchors observed for settled
 * turns are written into it, and responses whose anchor is currently
 * unavailable (answer not loaded, or the turn is the truncated tail) are
 * refilled from it. Anchors of in-progress turns are never remembered:
 * their final answer can still move.
 */
export function applyRememberedAnchors(
  responses: Map<string, TimelineTurnResponse>,
  remembered: Map<string, number>,
  settledTurnIds: ReadonlySet<string>
): Map<string, TimelineTurnResponse> {
  for (const [turnId, turn] of responses) {
    if (turn.finalStartedAtMs != null) {
      if (settledTurnIds.has(turnId)) remembered.set(turnId, turn.finalStartedAtMs);
    } else {
      const anchor = remembered.get(turnId);
      if (anchor != null) turn.finalStartedAtMs = anchor;
    }
  }
  return responses;
}
