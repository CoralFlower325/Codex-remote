import { describe, expect, it } from 'vitest';
import { applyHistoryWindow, historyBoundaryCursor, historyPageQuery } from './history-window-controller';
import { HISTORY_WINDOW_LIMIT } from './history-window';
import type { ThreadItem } from './types';

describe('rolling history recovery cursors', () => {
  it('keeps opaque native cursor bytes intact', () => {
    const cursor = '{"position":"native+&?#%"}';
    expect(historyPageQuery('thread', cursor, 'before').get('before')).toBe(cursor);
  });
  it('maps encoded local boundaries to exact native item anchors in either direction', () => {
    const cursor = historyBoundaryCursor({ turnId: 'turn # &', itemId: 'item ? %' });
    const before = historyPageQuery('thread', cursor, 'before');
    expect(Object.fromEntries(before)).toEqual({ threadId: 'thread', limit: '100',
      turnId: 'turn # &', beforeItem: 'item ? %', conversation: '1' });
    const after = historyPageQuery('thread', cursor, 'after');
    expect(after.get('afterItem')).toBe('item ? %');
    expect(after.has('conversation')).toBe(false);
  });
  it('rejects malformed local anchors instead of silently restarting at latest', () => {
    expect(() => historyPageQuery('thread', 'remote-item:%7B%7D', 'before')).toThrow();
    expect(() => historyPageQuery('thread', 'remote-item:%', 'after')).toThrow();
  });
  it('retains the opposite cursor and introduces recovery only for the discarded edge', () => {
    // Item count must exceed the default window cap (HISTORY_WINDOW_LIMIT,
    // 5,000 since virtualization; previously 800) for a discarded edge to
    // exist at all.
    const total = HISTORY_WINDOW_LIMIT + 1000;
    const items = Array.from({ length: total }, (_, i): ThreadItem =>
      ({ type: 'agentMessage', turnId: `turn-${Math.floor(i / 2)}`, id: String(i), text: String(i) }));
    const older = applyHistoryWindow(items, 'older', { older: 'native:older', newer: null });
    expect(older.items).toHaveLength(HISTORY_WINDOW_LIMIT);
    expect(older.older).toBe('native:older');
    expect(historyPageQuery('thread', older.newer, 'after').get('afterItem'))
      .toBe(String(HISTORY_WINDOW_LIMIT - 1));
    const newer = applyHistoryWindow(items, 'newer', { older: null, newer: 'native:newer' });
    expect(newer.items).toHaveLength(HISTORY_WINDOW_LIMIT);
    expect(newer.newer).toBe('native:newer');
    expect(historyPageQuery('thread', newer.older, 'before').get('beforeItem'))
      .toBe(String(total - HISTORY_WINDOW_LIMIT));
  });
});
