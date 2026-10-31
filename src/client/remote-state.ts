import type { Thread, ThreadItem } from './types';
import type { TurnTiming } from '../shared/turn-timing';
import { dedupeThreads } from './workspace-model';

export function reconcileThreadList(current: Thread[], snapshot: Thread[], baseline: Thread[]): Thread[] {
  const before = new Map(baseline.map(thread => [thread.id, thread]));
  const live = new Map(current.map(thread => [thread.id, thread]));
  const next = new Map(snapshot.filter(thread => !before.has(thread.id) || live.has(thread.id))
    .map(thread => [thread.id, thread]));
  for (const thread of current) {
    if (thread !== before.get(thread.id)) next.set(thread.id, thread);
  }
  return dedupeThreads([...next.values()]);
}

export function mergeTurnTimings(current: Record<string, TurnTiming>, latest: TurnTiming[], baseline: Record<string, TurnTiming>): Record<string, TurnTiming> {
  const next = { ...current };
  for (const turn of latest) {
    const existing = current[turn.id];
    next[turn.id] = existing && existing !== baseline[turn.id] ? existing
      : existing?.errorWillRetry && existing.error && turn.status === 'inProgress'
        ? { ...turn, error: existing.error, errorWillRetry: true } : turn;
  }
  return next;
}

export function mergeOlderTurnTimings(current: Record<string, TurnTiming>, older: TurnTiming[]): Record<string, TurnTiming> {
  return { ...Object.fromEntries(older.map(turn => [turn.id, turn])), ...current };
}

export function findActiveTurnId(turns: Thread['turns'] | undefined): string | null {
  return [...(turns ?? [])].reverse().find((turn) => turn.status === 'inProgress')?.id ?? null;
}

export function displayThreadTitle(thread: Thread): string {
  return thread.name || thread.preview?.split('\n')[0]?.slice(0, 80) || '未命名任务';
}

export function titlesMatch(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\u2026\s]+/g, '').trim();
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(b.slice(0, 24)) || b.startsWith(a.slice(0, 24));
}

function unseenTurnPosition(items: ThreadItem[], turnId: string | undefined, timings: Record<string, TurnTiming>): number {
  const start = turnId ? timings[turnId]?.startedAt : null;
  const later = start == null ? -1 : items.findIndex(item =>
    item.turnId && timings[item.turnId]?.startedAt != null && timings[item.turnId]!.startedAt! > start);
  // Do not extend the bounded history window for an unseen older turn.
  return later === 0 ? -1 : later < 0 ? items.length : later;
}

export function upsertItem(items: ThreadItem[], next: ThreadItem, append = false,
  timings: Record<string, TurnTiming> = {}): ThreadItem[] {
  const index = items.findIndex((item) => itemKey(item) === itemKey(next));
  if (index === -1) {
    // Late native items stay with their turn, never after a later conversation.
    let turnEnd = -1;
    if (next.turnId) for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.turnId === next.turnId) { turnEnd = i; break; }
    }
    if (turnEnd >= 0) return [...items.slice(0, turnEnd + 1), next, ...items.slice(turnEnd + 1)];
    const position = unseenTurnPosition(items, next.turnId, timings);
    return position < 0 ? items : [...items.slice(0, position), next, ...items.slice(position)];
  }
  const copy = [...items];
  const current = copy[index]!;
  if (append && current.type === 'agentMessage' && next.type === 'agentMessage') {
    copy[index] = { ...current, text: `${current.text}${next.text}` };
  } else {
    copy[index] = { ...next,
      ...(next.startedAtMs == null && current.startedAtMs != null ? { startedAtMs: current.startedAtMs } : {}),
      ...(next.completedAtMs == null && current.completedAtMs != null ? { completedAtMs: current.completedAtMs } : {}) };
  }
  return copy;
}

/** Apply a native turn payload in one pass, preserving bounded historical windows. */
export function mergeEmbeddedTurnItems(items: ThreadItem[], turnId: string, incoming: unknown, viewingHistory: boolean,
  timings: Record<string, TurnTiming> = {}): ThreadItem[] {
  if (!Array.isArray(incoming) || !incoming.length) return items;
  const currentTurn = items.filter(item => item.turnId === turnId);
  const existing = new Map(currentTurn.map(item => [itemKey(item), item]));
  const updates = new Map<string, ThreadItem>();
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string') continue;
    const next = { ...item, turnId } as ThreadItem;
    const key = itemKey(next), current = existing.get(key);
    if (!current && viewingHistory) continue;
    updates.set(key, { ...next,
      ...(next.startedAtMs == null && current?.startedAtMs != null ? { startedAtMs: current.startedAtMs } : {}),
      ...(next.completedAtMs == null && current?.completedAtMs != null ? { completedAtMs: current.completedAtMs } : {}) });
  }
  if (!updates.size) return items;
  if (viewingHistory) return items.map(item => updates.get(itemKey(item)) ?? item);
  // Reconcile inside the owning turn so delayed payloads cannot land after a later turn.
  // Keep local-only entries by their next known neighbour; the native array orders known items.
  const before = new Map<string, ThreadItem[]>();
  let prefix: ThreadItem[] = [];
  let anchored = false;
  let remaining: ThreadItem[] = [];
  for (const item of currentTurn) {
    const key = itemKey(item);
    if (updates.has(key)) {
      if (!anchored) { prefix = remaining; anchored = true; }
      else before.set(key, remaining);
      remaining = [];
    }
    else remaining.push(item);
  }
  if (!anchored) { prefix = remaining; remaining = []; }
  const merged = [...prefix, ...[...updates].flatMap(([key, item]) => [...(before.get(key) ?? []), item])];
  merged.push(...remaining);
  const start = items.findIndex(item => item.turnId === turnId);
  if (start === -1) {
    const position = unseenTurnPosition(items, turnId, timings);
    return position < 0 ? items : [...items.slice(0, position), ...merged, ...items.slice(position)];
  }
  return [...items.slice(0, start), ...merged,
    ...items.slice(start).filter(item => item.turnId !== turnId)];
}

export function itemKey(item: { id: string; turnId?: string }): string {
  return JSON.stringify([item.turnId ?? '', item.id]);
}

export function mergeLatestHistoryItems(
  current: ThreadItem[],
  latest: ThreadItem[],
  snapshotBaseline?: ThreadItem[]
): ThreadItem[] {
  const currentById = new Map(current.map((item, index) => [itemKey(item), { item, index }]));
  const baseline = snapshotBaseline && new Map(snapshotBaseline.map((item) => [itemKey(item), item]));
  const firstShared = latest.map((item) => currentById.get(itemKey(item))?.index).find((index) => index !== undefined);
  let cursor = firstShared ?? current.length;
  const next = current.slice(0, cursor);
  for (const item of latest) {
    const existing = currentById.get(itemKey(item));
    if (!existing) {
      next.push(item);
      continue;
    }
    while (cursor < existing.index) next.push(current[cursor++]!);
    const changedDuringRequest = baseline && baseline.get(itemKey(item)) !== existing.item;
    next.push(changedDuringRequest || JSON.stringify(existing.item) === JSON.stringify(item) ? existing.item : item);
    cursor = existing.index + 1;
  }
  next.push(...current.slice(cursor));
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
}

export function mergeOlderHistoryItems(older: ThreadItem[], current: ThreadItem[]): ThreadItem[] {
  const currentIds = new Set(current.map(itemKey));
  return [...older.filter((item) => !currentIds.has(itemKey(item))), ...current];
}
