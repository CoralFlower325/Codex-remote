import type { ThreadItem } from './types';

export interface HistoryBoundary {
  turnId: string;
  itemId: string;
}

export interface BoundedHistoryWindow {
  items: ThreadItem[];
  before: HistoryBoundary | null;
  after: HistoryBoundary | null;
}

const boundary = (item: ThreadItem | undefined): HistoryBoundary | null =>
  item?.turnId ? { turnId: item.turnId, itemId: item.id } : null;

/**
 * Whole-turn retreat avoids splitting an ordinary turn at the cut. It is
 * capped by span: a turn already occupying hundreds of retained items is
 * not ordinary, and retreating past it would evict the section the reader
 * is standing on in a single commit (the giant-turn boundary flash). Such
 * turns are cut by item anchor instead; the boundary cursor pages them.
 */
const MAX_WHOLE_TURN_SPAN = 200;

/**
 * Keep a rolling native history window without guessed layout heights.
 * Prefer whole turns; a single oversized turn is bounded by item anchors too.
 */
export function boundHistoryItems(
  items: ThreadItem[],
  direction: 'older' | 'newer',
  maxItems = 800,
  wholeTurns = true
): BoundedHistoryWindow {
  const limit = Math.max(1, Math.floor(maxItems));
  if (items.length <= limit) return { items, before: null, after: null };
  if (direction === 'older') {
    let end = limit;
    const cutTurn = items[end]?.turnId;
    if (wholeTurns && cutTurn && items[end - 1]?.turnId === cutTurn) {
      let start = end - 1;
      while (start > 0 && items[start - 1]?.turnId === cutTurn) start--;
      let spanEnd = end;
      while (spanEnd < items.length && items[spanEnd]?.turnId === cutTurn) spanEnd++;
      if (start > 0 && spanEnd - start <= MAX_WHOLE_TURN_SPAN) end = start;
    }
    const retained = items.slice(0, end);
    return { items: retained, before: null, after: boundary(retained.at(-1)) };
  }
  let start = items.length - limit;
  const cutTurn = items[start]?.turnId;
  if (wholeTurns && cutTurn && items[start - 1]?.turnId === cutTurn) {
    let end = start + 1;
    while (end < items.length && items[end]?.turnId === cutTurn) end++;
    let spanStart = start - 1;
    while (spanStart > 0 && items[spanStart - 1]?.turnId === cutTurn) spanStart--;
    if (end < items.length && end - spanStart <= MAX_WHOLE_TURN_SPAN) start = end;
  }
  const retained = items.slice(start);
  return { items: retained, before: boundary(retained[0]), after: null };
}
