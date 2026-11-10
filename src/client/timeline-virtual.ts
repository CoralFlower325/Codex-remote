import type { TimelineSection } from './timeline-model';

/**
 * Master switch for the section-virtualized timeline. The renderer keeps
 * this path behind a runtime check so acceptance can compare both paths in
 * one build: `?virt=0` forces the legacy full render, `?virt=1` forces
 * virtualization, anything else falls back to this constant.
 */
export const VIRTUALIZE_TIMELINE = true;

export function virtualizeTimelineEnabled(search?: string): boolean {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const override = new URLSearchParams(query).get('virt');
  if (override === '0') return false;
  if (override === '1') return true;
  return VIRTUALIZE_TIMELINE;
}

export interface RowMeasurement {
  key: unknown;
  start: number;
  size: number;
}

/**
 * Expand a visible index range until at least `overscanPx` of measured
 * content is included on both sides. Pixel overscan (rather than a fixed
 * row count) keeps the mounted window proportional to the viewport even
 * when a single section spans several screens.
 */
export function expandRangeByPixels(
  measurements: readonly RowMeasurement[],
  startIndex: number,
  endIndex: number,
  overscanPx: number
): number[] {
  const count = measurements.length;
  if (count === 0) return [];
  let start = Math.max(0, Math.min(count - 1, startIndex));
  let end = Math.max(0, Math.min(count - 1, endIndex));
  if (end < start) [start, end] = [end, start];
  const px = Math.max(0, overscanPx);
  let covered = 0;
  while (start > 0 && covered < px) {
    start--;
    covered += measurements[start]!.size;
  }
  covered = 0;
  while (end < count - 1 && covered < px) {
    end++;
    covered += measurements[end]!.size;
  }
  const indexes: number[] = [];
  for (let index = start; index <= end; index++) indexes.push(index);
  return indexes;
}

export interface KeyAnchor {
  key: string;
  offsetWithin: number;
}

/**
 * Capture the reading anchor as (row key, offset within that row) from
 * measured row geometry. Unlike a DOM node anchor this survives the row
 * being unmounted by the virtual window, and unlike a raw scrollTop it
 * survives pages being prepended above it.
 */
export function captureKeyAnchor(
  measurements: readonly RowMeasurement[],
  scrollTop: number
): KeyAnchor | null {
  if (measurements.length === 0) return null;
  let low = 0;
  let high = measurements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (measurements[middle]!.start <= scrollTop) low = middle + 1;
    else high = middle;
  }
  const item = measurements[Math.max(0, low - 1)]!;
  return { key: String(item.key), offsetWithin: scrollTop - item.start };
}

/** Resolve a key anchor back to an absolute scroll offset, or null when
 * the anchored row is no longer part of the retained rows. */
export function resolveKeyAnchor(
  measurements: readonly RowMeasurement[],
  anchor: KeyAnchor
): number | null {
  const item = measurements.find(measurement => String(measurement.key) === anchor.key);
  return item ? item.start + anchor.offsetWithin : null;
}

/**
 * Anchor to the first row starting at or below the scroll offset, with a
 * (zero or negative) in-row offset. Height growth in rows above — the
 * common activity-expansion case — shifts this row's start by exactly
 * the growth, so resolving the anchor afterwards compensates it fully,
 * where a top-of-viewport anchor sitting inside the growing row cannot.
 */
export function captureKeyAnchorBelow(
  measurements: readonly RowMeasurement[],
  scrollTop: number
): KeyAnchor | null {
  if (measurements.length === 0) return null;
  const item = measurements.find(measurement => measurement.start >= scrollTop)
    ?? measurements[measurements.length - 1]!;
  return { key: String(item.key), offsetWithin: scrollTop - item.start };
}

/**
 * Starting heights for unmeasured sections. These only seed the scroll
 * geometry before the first real measurement lands; the virtualizer
 * replaces them with measured heights and corrects the scroll position
 * for items above the fold, so they should be plausible, not precise.
 */
export function estimateSectionHeight(section: TimelineSection, expanded: boolean): number {
  if (section.user) return 120;
  return expanded ? 680 : 150;
}
