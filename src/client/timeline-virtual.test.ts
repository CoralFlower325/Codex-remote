import { describe, expect, it } from 'vitest';

import {
  captureKeyAnchor, captureKeyAnchorBelow, estimateSectionHeight, expandRangeByPixels, resolveKeyAnchor,
  virtualizeTimelineEnabled, type RowMeasurement
} from './timeline-virtual';
import type { TimelineSection } from './timeline-model';

const measurements = (sizes: number[], firstStart = 0): RowMeasurement[] => {
  let start = firstStart;
  return sizes.map((size, index) => {
    const item = { key: `k${index}`, start, size };
    start += size;
    return item;
  });
};

describe('virtualizeTimelineEnabled', () => {
  it('defaults to the master switch without an override', () => {
    expect(virtualizeTimelineEnabled('')).toBe(true);
    expect(virtualizeTimelineEnabled('?other=1')).toBe(true);
  });
  it('honours explicit ?virt= overrides', () => {
    expect(virtualizeTimelineEnabled('?virt=0')).toBe(false);
    expect(virtualizeTimelineEnabled('?virt=1')).toBe(true);
    expect(virtualizeTimelineEnabled('?virt=yes')).toBe(true);
  });
});

describe('expandRangeByPixels', () => {
  const rows = measurements([100, 100, 100, 100, 100, 100, 100, 100]);
  it('returns nothing for no rows', () => {
    expect(expandRangeByPixels([], 0, 0, 500)).toEqual([]);
  });
  it('keeps the visible range when overscan is zero', () => {
    expect(expandRangeByPixels(rows, 3, 4, 0)).toEqual([3, 4]);
  });
  it('expands until the pixel budget is covered on both sides', () => {
    // 250px above index 3 needs rows 2,1,0 (300px); below index 4 rows 5,6,7.
    expect(expandRangeByPixels(rows, 3, 4, 250)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(expandRangeByPixels(rows, 3, 4, 150)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('clamps at both ends of the list', () => {
    expect(expandRangeByPixels(rows, 0, 1, 10_000)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(expandRangeByPixels(rows, 6, 7, 10_000)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('counts one giant row once even when it exceeds the budget alone', () => {
    const giant = measurements([5000, 100, 100]);
    expect(expandRangeByPixels(giant, 1, 1, 1350)).toEqual([0, 1, 2]);
  });
});

describe('key anchors', () => {
  const rows = measurements([100, 200, 100, 400]);
  it('captures the row containing the scroll offset and the offset within it', () => {
    expect(captureKeyAnchor(rows, 0)).toEqual({ key: 'k0', offsetWithin: 0 });
    expect(captureKeyAnchor(rows, 250)).toEqual({ key: 'k1', offsetWithin: 150 });
    expect(captureKeyAnchor(rows, 799)).toEqual({ key: 'k3', offsetWithin: 399 });
  });
  it('captures a negative offset while the reader is in the start padding', () => {
    const padded = measurements([100, 100], 52);
    expect(captureKeyAnchor(padded, 20)).toEqual({ key: 'k0', offsetWithin: -32 });
    expect(resolveKeyAnchor(padded, { key: 'k0', offsetWithin: -32 })).toBe(20);
  });
  it('round-trips through capture and resolve', () => {
    for (const top of [0, 42, 100, 299, 300, 555, 800]) {
      const anchor = captureKeyAnchor(rows, top)!;
      expect(resolveKeyAnchor(rows, anchor)).toBe(top);
    }
  });
  it('resolves to the shifted start after a page is prepended above', () => {
    const anchor = captureKeyAnchor(rows, 250)!;
    const prepended: RowMeasurement[] = [
      { key: 'new0', start: 0, size: 50 },
      { key: 'new1', start: 50, size: 50 },
      ...rows.map(item => ({ ...item, start: item.start + 100 }))
    ];
    expect(resolveKeyAnchor(prepended, anchor)).toBe(350);
  });
  it('returns null when the anchored row left the retained rows', () => {
    expect(resolveKeyAnchor(rows, { key: 'gone', offsetWithin: 10 })).toBeNull();
    expect(captureKeyAnchor([], 10)).toBeNull();
  });
  it('anchors below the offset so growth above shifts the resolution by the growth', () => {
    // Offset 250 sits inside k1 (100..300); the next row down is k2 at 300.
    const anchor = captureKeyAnchorBelow(rows, 250)!;
    expect(anchor).toEqual({ key: 'k2', offsetWithin: -50 });
    // k0 grows by 90: every later start shifts by 90, resolution follows.
    const grown = measurements([190, 200, 100, 400]);
    expect(resolveKeyAnchor(grown, anchor)).toBe(340);
    expect(captureKeyAnchorBelow([], 10)).toBeNull();
    // Past the last row start, the last row is the anchor.
    expect(captureKeyAnchorBelow(rows, 10_000)).toEqual({ key: 'k3', offsetWithin: 9_600 });
  });
});

describe('estimateSectionHeight', () => {
  const user: TimelineSection = { key: 'u', turnId: 't', entries: [], user: true, showTiming: false };
  const response: TimelineSection = { key: 'r', turnId: 't', entries: [], user: false, showTiming: true };
  it('gives positive plausible seeds and larger ones for expanded responses', () => {
    expect(estimateSectionHeight(user, false)).toBeGreaterThan(0);
    expect(estimateSectionHeight(response, false)).toBeGreaterThan(0);
    expect(estimateSectionHeight(response, true)).toBeGreaterThan(estimateSectionHeight(response, false));
  });
});
