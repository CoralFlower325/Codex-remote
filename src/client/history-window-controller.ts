import { boundHistoryItems, type HistoryBoundary } from './history-window';
import type { ThreadItem } from './types';

const anchorPrefix = 'remote-item:';

export function historyBoundaryCursor(boundary: HistoryBoundary): string {
  return anchorPrefix + encodeURIComponent(JSON.stringify(boundary));
}

export function historyPageQuery(threadId: string, cursor: string | null, direction: 'before' | 'after') {
  const query = new URLSearchParams({ threadId, limit: cursor === null ? '40' : '100' });
  if (cursor?.startsWith(anchorPrefix)) {
    const anchor = JSON.parse(decodeURIComponent(cursor.slice(anchorPrefix.length))) as HistoryBoundary;
    if (typeof anchor.turnId !== 'string' || !anchor.turnId || typeof anchor.itemId !== 'string' || !anchor.itemId)
      throw new Error('Invalid local history boundary.');
    query.set('turnId', anchor.turnId);
    query.set(direction === 'before' ? 'beforeItem' : 'afterItem', anchor.itemId);
  } else if (cursor !== null) query.set(direction, cursor);
  if (cursor !== null && direction === 'before') query.set('conversation', '1');
  return query;
}

export function applyHistoryWindow(items: ThreadItem[], direction: 'older' | 'newer',
  cursors: { older: string | null; newer: string | null }, maxItems = 800, wholeTurns = true) {
  const bounded = boundHistoryItems(items, direction, maxItems, wholeTurns);
  return {
    items: bounded.items,
    older: bounded.before ? historyBoundaryCursor(bounded.before) : cursors.older,
    newer: bounded.after ? historyBoundaryCursor(bounded.after) : cursors.newer,
    trimmed: bounded.items !== items
  };
}
