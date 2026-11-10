import { describe, expect, it } from 'vitest';
import { boundHistoryItems } from './history-window';
import type { ThreadItem } from './types';

const item = (turnId: string, id: number): ThreadItem =>
  ({ type: 'agentMessage', turnId, id: String(id), text: `Item ${id}` });
const turn = (turnId: string, count: number) => Array.from({ length: count }, (_, id) => item(turnId, id));

describe('bounded native history windows', () => {
  it('keeps the original array while no trimming is needed', () => {
    const items = turn('small', 3);
    expect(boundHistoryItems(items, 'older', 4)).toEqual({ items, before: null, after: null });
    expect(boundHistoryItems(items, 'newer', 4).items).toBe(items);
  });

  it('drops complete later turns when loading older pages', () => {
    const items = [...turn('one', 3), ...turn('two', 3), ...turn('three', 3)];
    const bounded = boundHistoryItems(items, 'older', 7);
    expect(bounded.items).toEqual(items.slice(0, 6));
    expect(bounded.after).toEqual({ turnId: 'two', itemId: '2' });
    expect(bounded.before).toBeNull();
    expect(items).toHaveLength(9);
  });

  it('drops complete earlier turns when loading later pages', () => {
    const items = [...turn('one', 3), ...turn('two', 3), ...turn('three', 3)];
    const bounded = boundHistoryItems(items, 'newer', 7);
    expect(bounded.items).toEqual(items.slice(3));
    expect(bounded.before).toEqual({ turnId: 'two', itemId: '0' });
    expect(bounded.after).toBeNull();
  });

  it('bounds a single huge turn with exact item boundaries instead of growing indefinitely', () => {
    const items = turn('huge', 2000);
    expect(boundHistoryItems(items, 'older').items).toHaveLength(800);
    expect(boundHistoryItems(items, 'older').after).toEqual({ turnId: 'huge', itemId: '799' });
    expect(boundHistoryItems(items, 'newer').items).toHaveLength(800);
    expect(boundHistoryItems(items, 'newer').before).toEqual({ turnId: 'huge', itemId: '1200' });
  });

  it('does not discard the whole requested window when its first or last turn is oversized', () => {
    // Geometry of the giant-turn boundary flash: a few small turns, then a
    // turn with thousands of records. Retreating past the giant turn would
    // drop every loaded item of the section being read in one commit, so the
    // window cuts it by item anchor and keeps the full requested size.
    const items = [...turn('one', 10), ...turn('huge', 2000), ...turn('last', 10)];
    const older = boundHistoryItems(items, 'older', 800);
    expect(older.items).toHaveLength(800);
    expect(older.items.slice(0, 10)).toEqual(items.slice(0, 10));
    expect(older.after).toEqual({ turnId: 'huge', itemId: '789' });
    const newer = boundHistoryItems(items, 'newer', 800);
    expect(newer.items).toHaveLength(800);
    expect(newer.items.slice(-10)).toEqual(items.slice(-10));
    expect(newer.before).toEqual({ turnId: 'huge', itemId: '1210' });
  });

  it('still retreats past a modest straddling turn to keep it whole', () => {
    const items = [...turn('one', 10), ...turn('mid', 150), ...turn('last', 700)];
    const older = boundHistoryItems(items, 'older', 100);
    expect(older.items).toEqual(items.slice(0, 10));
    expect(older.after).toEqual({ turnId: 'one', itemId: '9' });
    const newerItems = [...turn('first', 900), ...turn('mid', 150), ...turn('last', 10)];
    const newer = boundHistoryItems(newerItems, 'newer', 100);
    expect(newer.items).toEqual(newerItems.slice(-10));
    expect(newer.before).toEqual({ turnId: 'last', itemId: '0' });
  });

  it('supports ungrouped legacy records and a one-item bound', () => {
    const items = turn('one', 3).map(({ turnId: _, ...record }) => record as ThreadItem);
    expect(boundHistoryItems(items, 'newer', 1)).toEqual({ items: items.slice(-1), before: null, after: null });
    expect(boundHistoryItems(turn('one', 3), 'older', 1).items).toHaveLength(1);
  });

  it('retains every already rendered record while holding a live reading window', () => {
    const visible = [...turn('previous', 400), ...turn('running', 400)];
    const next = [...visible, item('running', 400)];
    const bounded = boundHistoryItems(next, 'older', 800, false);
    expect(bounded.items).toEqual(visible);
    expect(bounded.after).toEqual({ turnId: 'running', itemId: '399' });
  });
});
