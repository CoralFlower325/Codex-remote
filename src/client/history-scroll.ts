export type BeforeHistoryCommit = () => Promise<boolean>;

export function historyScrollDelta(previous: number, current: number, maximum: number): number {
  const bounded = (top: number) => Math.max(0, Math.min(Math.max(0, maximum), top));
  return bounded(current) - bounded(previous);
}

/**
 * Later pages may load only when the reader is genuinely near the end of
 * the retained window and is not travelling upward. A window trimmed to
 * the item cap can be shorter than a two-viewport lookahead once activity
 * folds; the old distance-only trigger then stayed true even at the very
 * top, and every later page dragged the window back towards the latest
 * items, discarding the older pages the reader had just loaded.
 *
 * Distance alone still cannot tell "standing at the top" from "arrived at
 * the bottom" when the whole window is barely taller than the viewport:
 * the reader is permanently within range of its end, and any pause
 * between upward gestures would let a later page through. So the reader
 * must also have travelled towards the end (scrolled past half a
 * viewport) or have just made an explicit downward gesture.
 */
export function laterHistoryLoadReady(distanceToBottom: number, viewportHeight: number,
  wantsEarlier: boolean, travelledToEnd: boolean): boolean {
  if (wantsEarlier || !travelledToEnd) return false;
  return distanceToBottom <= Math.max(0, viewportHeight) * 0.5;
}

/** Keep history layout changes out of both the drag and its momentum scroll. */
export class HistoryScroll {
  private touching = false;
  private touchY: number | null = null;
  private directedTouch = false;
  private idle = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readers: Array<(ready: boolean) => void> = [];

  constructor(private readonly onIdle: () => void) {}

  get hasTouchIntent(): boolean { return this.directedTouch; }

  /** True once a full quiet window has passed with no scroll activity. */
  get isIdle(): boolean { return this.idle; }

  startTouch(y: number | null = null): void {
    this.touching = true;
    this.touchY = y;
    this.directedTouch = false;
    this.activity();
  }

  moveTouch(y: number | null): -1 | 1 | null {
    if (y === null || this.touchY === null) return null;
    const delta = y - this.touchY;
    // Accumulate small moves instead of discarding every sub-threshold event.
    if (Math.abs(delta) <= 2) return null;
    this.touchY = y;
    this.directedTouch = true;
    return delta > 0 ? -1 : 1;
  }

  endTouch(): void {
    this.touching = false;
    this.touchY = null;
    this.activity();
  }

  activity(): void {
    this.idle = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.touching) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.idle = true;
      this.directedTouch = false;
      this.readers.splice(0).forEach(resolve => resolve(true));
      this.onIdle();
    }, 160);
  }

  waitForIdle(): Promise<boolean> {
    return this.idle ? Promise.resolve(true) : new Promise(resolve => this.readers.push(resolve));
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.touching = false;
    this.touchY = null;
    this.directedTouch = false;
    this.idle = true;
    this.readers.splice(0).forEach(resolve => resolve(false));
  }
}
