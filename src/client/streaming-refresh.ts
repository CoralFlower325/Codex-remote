export interface StreamFlushContext {
  /** The tab is hidden (document.visibilityState). */
  hidden: boolean;
  /** The network is constrained (Save-Data or a slow effective type). */
  constrained: boolean;
  /** The reader has scrolled away from the bottom to read retained history. */
  readingHistory: boolean;
}

/**
 * Streaming deltas are coalesced behind one flush timer whose cadence is
 * chosen when the timer is armed (and re-chosen for every later batch).
 * The tiers are a strict priority order, not a maximum:
 *
 * - A hidden tab never needs better than the historical 250ms.
 * - A reader who left the bottom is reading retained history. Repainting
 *   the growing tail five times a second steals main-thread time from
 *   their scrolling to update content they are not looking at, so the
 *   flush slows to 300ms until they return to the latest — at which
 *   point the pending batch is flushed immediately (see useRemote's
 *   history-reading transition), never dropped.
 * - A constrained network keeps the historical 100ms.
 * - Otherwise the follow-the-tail cadence stays 60ms.
 */
export function streamFlushDelayMs({ hidden, constrained, readingHistory }: StreamFlushContext): number {
  if (hidden) return 250;
  if (readingHistory) return 300;
  if (constrained) return 100;
  return 60;
}
