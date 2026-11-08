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
      if (start > 0) end = start;
    }
    const retained = items.slice(0, end);
    return { items: retained, before: null, after: boundary(retained.at(-1)) };
  }
  let start = items.length - limit;
  const cutTurn = items[start]?.turnId;
  if (wholeTurns && cutTurn && items[start - 1]?.turnId === cutTurn) {
    let end = start + 1;
    while (end < items.length && items[end]?.turnId === cutTurn) end++;
    if (end < items.length) start = end;
  }
  const retained = items.slice(start);
  return { items: retained, before: boundary(retained[0]), after: null };
}
