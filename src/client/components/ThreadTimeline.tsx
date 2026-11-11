import { ArrowDown, LoaderCircle, MessageSquareText, RotateCw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HistoryThreadContext } from '../history-details';
import { itemKey } from '../remote-state';
import type { ThreadItem } from '../types';
import { applyRememberedAnchors, projectTimeline, timelineTurnResponses, type TimelineChainCache, type TimelineEntry, type TimelineSection } from '../timeline-model';
import type { TurnTiming } from '../../shared/turn-timing';
import type { OutlineTurn } from '../../shared/thread-outline';
import { ThreadNavigation, type NavigationTarget } from './ThreadNavigation';
import { captureBlockAnchor, captureReadingAnchor, releaseReadingTail, restoreReadingAnchor, settleBlockAnchor, type BlockAnchor, type ReadingAnchor } from '../reading-anchor';
import { HistoryScroll, historyScrollDelta, laterHistoryLoadReady, type BeforeHistoryCommit } from '../history-scroll';
import { expandRangeByPixels, resolveSizeChangeAdjustment,
  shouldAdjustForSizeChange, virtualizeTimelineEnabled, type KeyAnchor } from '../timeline-virtual';
import { createTimelineLayoutCache, estimateLayoutRowHeight, projectLayoutRows, turnIsCompleted,
  type TimelineLayoutCache, type TimelineLayoutContext } from '../timeline-layout';
import { defaultRangeExtractor, useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';
import { isReadableHistoryItem } from '../history-prefetch';
import { NativeTurnError } from './NativeTurnError';
import { ResponseSection, MessageItem, TurnDuration } from './TurnResponse';
import type { UserMessage } from '../message-edit';
import { parseHeartbeatPrompt } from '../../shared/heartbeat';
export { MarkdownText } from './MarkdownText';

interface ThreadTimelineProps {
  threadId: string;
  items: ThreadItem[];
  loading: boolean;
  snapshotState?: 'loading' | 'failed' | null;
  onRetrySnapshot?: () => void;
  activeTurnId: string | null;
  threadIdle?: boolean;
  turnTimings: Record<string, TurnTiming>;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  onLoadEarlier: (beforeCommit?: BeforeHistoryCommit) => Promise<void>;
  onPrefetchEarlier?: () => Promise<void>;
  outlineTurns?: OutlineTurn[];
  outlineError?: string | null;
  viewingHistory?: boolean;
  hasNewerHistory?: boolean;
  newerHistoryCursor?: string | null;
  loadingLaterHistory?: boolean;
  revealingHistory?: boolean;
  onLoadLater?: (beforeCommit?: BeforeHistoryCommit) => Promise<void>;
  onRevealHistory?: (turnId: string, itemId: string) => Promise<boolean>;
  onCancelHistoryReveal?: () => void;
  onReturnToLatest?: () => Promise<void>;
  onHistoryReading?: (threadId: string, reading: boolean) => void;
  onFork?: (turnId: string) => Promise<void>;
  onActionError?: (error: unknown) => void;
  editableMessageId?: string | undefined;
  onEditMessage?: ((item: UserMessage) => void) | undefined;
}

export function ThreadTimeline({
  threadId,
  items,
  loading,
  snapshotState = null,
  onRetrySnapshot,
  activeTurnId,
  threadIdle = false,
  turnTimings,
  hasMoreHistory,
  loadingHistory,
  onLoadEarlier,
  onPrefetchEarlier,
  outlineTurns = [],
  outlineError = null,
  viewingHistory = false,
  hasNewerHistory = false,
  newerHistoryCursor = null,
  loadingLaterHistory = false,
  revealingHistory = false,
  onLoadLater,
  onRevealHistory,
  onCancelHistoryReveal,
  onReturnToLatest,
  onHistoryReading,
  onFork,
  onActionError,
  editableMessageId,
  onEditMessage
}: ThreadTimelineProps) {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollReadyRef = useRef(false);
  const loadingEarlierRef = useRef(false);
  const earlierAttemptRef = useRef<string | null>(null);
  const prefetchAttemptRef = useRef<string | null>(null);
  const navigationVersionRef = useRef(0);
  const navigatingRef = useRef(false);
  const navigationAnchorRef = useRef<string | null>(null);
  const readingAnchorRef = useRef<ReadingAnchor | null>(null);
  const blockAnchorRef = useRef<BlockAnchor | null>(null);
  const blockSettlePendingRef = useRef(false);
  const blockSettleVersionRef = useRef(0);
  // Streaming-frequency row restores are coalesced into one settle at the
  // HistoryScroll idle point instead of a geometry pass per flush.
  const anchorSettlePendingRef = useRef(false);
  const anchorSettleVersionRef = useRef(0);
  // A size-change adjustment the virtualizer predicate suppressed during
  // a gesture: the measurement is kept, the write is owed, and the idle
  // handler must run an anchor settle to pay it even if nothing else
  // changes afterwards.
  const sizeCompensationDeferredRef = useRef(false);
  // From a history commit (an earlier/later page landing, a window
  // trim) until the scroll next goes idle, row-size changes belong to
  // the history settle, not to streaming growth: the virtualizer's
  // default compensation for them must land synchronously, exactly as
  // the synchronous reading-position restore does, or a reader (or an
  // acceptance probe) measuring right after the commit catches the
  // anchor mid-settle. The gesture freeze only governs size changes
  // outside this window.
  const historySettleRef = useRef(false);
  const virtualRestoreFrameRef = useRef(0);
  const virtualRestoreAttemptsRef = useRef(0);
  const virtualRestoreGuardUntilRef = useRef(0);
  const restoreReadingPositionRef = useRef<() => void>(() => {});
  // Scroll compensation other layers wrote since the block anchor was
  // captured, credited in the scroll handler from registered restore
  // echoes. The in-row settle pays growth minus this credit, so a shift
  // the row-level restores already covered is never paid a second time.
  const blockCompensatedRef = useRef(0);
  // The settle's own writes register here instead of the shared restore
  // marker: their echo must read as compensation (not a gesture) without
  // being credited against the settle itself, or the next settle would
  // compute a negative debt and undo this one.
  const blockSettleEchoRef = useRef<number | null>(null);
  const restoredScrollTopRef = useRef<number | null>(null);
  const readingFrameRef = useRef(0);
  const mountedRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const wantsEarlierRef = useRef(false);
  const earlierBoundaryRef = useRef<string | null>(null);
  const continuationTopRef = useRef<number | null>(null);
  const loadWhenIdleRef = useRef<() => void>(() => {});
  const scrollActivityRef = useRef<HistoryScroll | null>(null);
  if (!scrollActivityRef.current) scrollActivityRef.current = new HistoryScroll(() => loadWhenIdleRef.current());
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [navigationContext, setNavigationContext] = useState(false);
  const laterSentinelRef = useRef<HTMLDivElement | null>(null);
  const laterAttemptRef = useRef<string | null>(null);
  const laterPendingRef = useRef(false);
  const forwardIntentRef = useRef(0);
  const loadLaterRef = useRef<() => void>(() => {});
  // The incremental chain resumes from scan checkpoints when a change
  // is confined to the tail (the streaming shape) and falls back to the
  // full builders for any other shape; its output is pinned to the full
  // builders by the timeline-chain equivalence tests.
  const chainCacheRef = useRef<TimelineChainCache | null>(null);
  const projection = useMemo(() => projectTimeline(items, activeTurnId, chainCacheRef.current),
    [items, activeTurnId]);
  chainCacheRef.current = projection.cache;
  const entries = projection.entries;
  const sections = projection.sections;
  // While the window is bounded on the newer side, its last turn may be
  // truncated mid-turn; do not let a partial slice anchor its duration.
  const truncatedTailTurnId = hasNewerHistory ? items.at(-1)?.turnId ?? null : null;
  // Anchors of settled turns are remembered for the rest of the viewing
  // session so the divider cannot flip back to the native duration when
  // the final answer scrolls out of the window again.
  const anchorMemoryRef = useRef(new Map<string, number>());
  useEffect(() => () => { anchorMemoryRef.current.clear(); }, [threadId]);
  const settledTurnIds = useMemo(() => new Set(Object.values(turnTimings)
    .filter(turn => turn.status !== 'inProgress' && turn.completedAt != null)
    .map(turn => turn.id)), [turnTimings]);
  const responses = useMemo(() => applyRememberedAnchors(
    timelineTurnResponses(sections, truncatedTailTurnId), anchorMemoryRef.current, settledTurnIds),
    [sections, truncatedTailTurnId, settledTurnIds]);
  const heartbeatTurns = useMemo(() => new Set(items.flatMap(item =>
    item.type === 'userMessage' && item.turnId && parseHeartbeatPrompt(
      item.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'))
      ? [item.turnId] : [])), [items]);
  const emptyError = items.length === 0 ? turnTimings[activeTurnId ?? ''] ??
    Object.values(turnTimings).find(turn => turn.error) : undefined;
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const toggleTurn = useCallback((turnId: string) => {
    setExpandedTurns(previous => {
      const next = new Set(previous);
      if (!next.delete(turnId)) next.add(turnId);
      return next;
    });
  }, []);
  // --- Layout projection & virtualization (timeline-layout.ts holds the
  // projection, timeline-virtual.ts the pure geometry logic) ---
  // Rows are the layout projection of the sections — a completed, folded
  // turn contributes only its content-bearing sections, so trace-only
  // mid-turn sections (the empty slices a steering message cuts into a
  // turn) never become virtual rows — plus the standalone turn-error
  // notice and the in-progress turn placeholder as tail rows, so the
  // virtual list owns every block the legacy flow render placed inside
  // the stream. The projection is cached per turn: a history prepend
  // re-projects only the new turns and the boundary turn.
  interface TimelineRow { key: string; section: TimelineSection | null; sectionIndex: number; tail?: boolean; notice?: boolean }
  const virtualWanted = useMemo(() => virtualizeTimelineEnabled(), []);
  const [virtualActive, setVirtualActive] = useState(false);
  const [virtualTailPx, setVirtualTailPx] = useState(0);
  const virtualActiveRef = useRef(false);
  virtualActiveRef.current = virtualActive;
  const keyAnchorRef = useRef<KeyAnchor | null>(null);
  const layoutCacheRef = useRef<TimelineLayoutCache | null>(null);
  if (!layoutCacheRef.current) layoutCacheRef.current = createTimelineLayoutCache();
  useEffect(() => () => { layoutCacheRef.current = createTimelineLayoutCache(); }, [threadId]);
  const layoutContext: TimelineLayoutContext = { expandedTurns, activeTurnId, threadIdle, turnTimings, responses };
  const layout = useMemo(() => projectLayoutRows(sections, layoutContext, layoutCacheRef.current!),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, expandedTurns, activeTurnId, threadIdle, turnTimings, responses]);
  layoutCacheRef.current = layout.cache;
  const rows = useMemo<TimelineRow[]>(() => {
    const list: TimelineRow[] = layout.rows.map(row => ({ key: row.key, section: row.section, sectionIndex: row.sectionIndex }));
    if (emptyError?.error) list.push({ key: '__turn-error', section: null, sectionIndex: -1, notice: true });
    if (!viewingHistory && activeTurnId &&
        !sections.some(section => !section.user && section.turnId === activeTurnId)) {
      list.push({ key: '__active-turn', section: null, sectionIndex: -1, tail: true });
    }
    return list;
  }, [layout.rows, emptyError, viewingHistory, activeTurnId, sections]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hasMoreHistoryRef = useRef(hasMoreHistory);
  hasMoreHistoryRef.current = hasMoreHistory;
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const estimateRowSize = (index: number): number => {
    const row = rowsRef.current[index];
    if (!row) return 240;
    if (row.tail || row.notice) return 48;
    const section = row.section!;
    const turnId = section.turnId;
    return estimateLayoutRowHeight(section, {
      expanded: turnId ? expandedTurns.has(turnId) : false,
      completed: turnId ? turnIsCompleted(turnId, layoutContext) : false,
      showError: turnId ? responses.get(turnId)?.lastResponseKey === section.key &&
        turnTimings[turnId]?.error != null : false
    });
  };
  const estimateRowSizeRef = useRef(estimateRowSize);
  estimateRowSizeRef.current = estimateRowSize;
  // A row's measured size is only valid for the layout state that
  // produced it: when a turn folds or unfolds (toggle, or its timing
  // landing), the same section key renders a different height class, so
  // a cached measurement from the other state must not feed the anchor
  // geometry. Measurements are keyed by row key + layout signature.
  const rowLayoutSigRef = useRef(new Map<string, string>());
  useEffect(() => { rowLayoutSigRef.current.clear(); }, [threadId]);
  const rowLayoutSignature = (row: TimelineRow): string => {
    const turnId = row.section?.turnId;
    if (!turnId) return 'x';
    return `${expandedTurns.has(turnId) ? 'o' : 's'}${turnIsCompleted(turnId, layoutContext) ? 'd' : 'l'}`;
  };
  // Full row geometry rebuilt from the virtualizer's measured-size
  // snapshot plus our own estimates for unmeasured rows — the same inputs
  // the virtualizer itself uses, so starts agree with its layout.
  const currentMeasurements = (): Array<{ key: string; start: number; size: number }> => {
    const instance = virtualizerRef.current;
    if (!instance) return [];
    const measured = new Map(instance.takeSnapshot().map(item => [String(item.key), item.size]));
    let start = hasMoreHistoryRef.current ? 52 : 0;
    return rowsRef.current.map((row, index) => {
      const signature = rowLayoutSignature(row);
      let size: number;
      if (rowLayoutSigRef.current.get(row.key) !== signature) {
        // First sight of this row in this layout state: any cached
        // measurement belongs to the other fold state — seed instead.
        rowLayoutSigRef.current.set(row.key, signature);
        size = estimateRowSize(index);
      } else {
        size = measured.get(row.key) ?? estimateRowSize(index);
      }
      const measurement = { key: row.key, start, size };
      start += size;
      return measurement;
    });
  };
  // Folding or unfolding a turn changes its rows' height class; refresh
  // the virtualizer's cached sizes for exactly those rows — measured
  // where the row is mounted, structurally estimated where it is not —
  // so an unmounted row of the toggled turn is not laid out with its
  // other-state measurement when it scrolls back in.
  const previousExpandedRef = useRef(expandedTurns);
  useLayoutEffect(() => {
    const previous = previousExpandedRef.current;
    previousExpandedRef.current = expandedTurns;
    const instance = virtualizerRef.current;
    if (!instance || previous === expandedTurns) return;
    const changed = new Set<string>();
    for (const turnId of expandedTurns) if (!previous.has(turnId)) changed.add(turnId);
    for (const turnId of previous) if (!expandedTurns.has(turnId)) changed.add(turnId);
    if (changed.size === 0) return;
    rowsRef.current.forEach((row, index) => {
      if (row.section?.turnId && changed.has(row.section.turnId)) {
        // A mounted row of the toggled turn has just rendered in its
        // new fold state in this very commit: seed from its real
        // height — the same offsetHeight measureElement reports — so
        // no estimate→measure correction lands a beat later and
        // shifts every row below it (the structural estimate misses
        // by the trace pricing's slack). Rows outside the mounted
        // window keep the structural estimate.
        const element = innerRef.current?.querySelector<HTMLElement>(
          `.timeline-row[data-index="${index}"]`);
        const measured = element?.offsetHeight ?? 0;
        instance.resizeItem(index, measured > 0 ? measured : estimateRowSizeRef.current(index));
      }
    });
  }, [expandedTurns]);
  const currentMeasurementsRef = useRef(currentMeasurements);
  currentMeasurementsRef.current = currentMeasurements;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => streamRef.current,
    estimateSize: estimateRowSize,
    getItemKey: index => rows[index]?.key ?? index,
    overscan: 0,
    rangeExtractor: range => {
      const instance = virtualizerRef.current;
      if (!instance) return defaultRangeExtractor(range);
      // Pixel overscan: about 1.5 viewports of measured content per side,
      // so a fast fling meets mounted rows instead of blank space.
      return expandRangeByPixels(currentMeasurementsRef.current(), range.startIndex, range.endIndex,
        (instance.scrollRect?.height ?? 0) * 1.5);
    },
    // Reserve the history sentinels' flow space (32px + 20px margin) so
    // total geometry matches the legacy layout; the spinners themselves
    // are rendered as overlays at both ends of the virtual list.
    paddingStart: hasMoreHistory ? 52 : 0,
    paddingEnd: hasNewerHistory ? 52 : 0,
    // Programmatic writes (size-change adjustments, scrollToIndex) are
    // layout compensation, not reader gestures: register each target as
    // a restored offset so the scroll handler ignores its echo, exactly
    // like DOM-anchor restores. Without this, an adjustment's downward
    // echo reads as a downward gesture and reopens the later-page gate.
    ...({
      // Supported by virtual-core but omitted from the React wrapper's type.
      // The measurement is kept by the library even when this returns
      // false; only the write is dropped, so a suppression is a debt the
      // keyed-anchor restore settles at the scroll idle point. When this
      // predicate suppresses an adjustment the library default would
      // have made, it flags the debt so the idle handler guarantees a
      // settle runs even if nothing else changes afterwards.
      shouldAdjustScrollPositionOnItemSizeChange: (item: VirtualItem, _delta: number,
        instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => {
        const activity = scrollActivityRef.current!;
        const libraryDefault = shouldAdjustForSizeChange({
          hasKeyAnchor: false, touchIntent: false, scrollIdle: true,
          firstMeasure: !instance.itemSizeCache.has(item.key),
          itemStart: item.start, itemSize: item.size,
          scrollOffset: instance.scrollOffset ?? 0, scrollDirection: instance.scrollDirection
        });
        // History commits keep the library's synchronous compensation
        // until the settle completes at the next idle point (see
        // historySettleRef); the freeze below is for streaming growth.
        const allowed = shouldAdjustForSizeChange({
          hasKeyAnchor: Boolean(keyAnchorRef.current),
          // The freeze gates on directed touch only, deliberately not
          // on the idle signal: scroll activity also fires for wheel
          // paging and for programmatic restore echoes, and freezing
          // compensation there starves history paging of the library's
          // synchronous settle (the debt's idle restore then fights
          // the reader's own scroll position). A touch fling's
          // momentum window is already covered: directedTouch stays
          // set from the first directed move until the 160ms quiet
          // timer resets it, which is exactly the gesture-plus-inertia
          // span the freeze exists for.
          touchIntent: activity.hasTouchIntent, scrollIdle: true,
          firstMeasure: !instance.itemSizeCache.has(item.key),
          itemStart: item.start, itemSize: item.size,
          scrollOffset: instance.scrollOffset ?? 0, scrollDirection: instance.scrollDirection
        });
        const resolved = resolveSizeChangeAdjustment({
          historySettle: historySettleRef.current,
          touchIntent: activity.hasTouchIntent,
          libraryDefault,
          readingAdjustment: allowed
        });
        if (libraryDefault && !resolved) sizeCompensationDeferredRef.current = true;
        return resolved;
      }
    } as { shouldAdjustScrollPositionOnItemSizeChange:
      (item: VirtualItem, delta: number, instance: Virtualizer<HTMLDivElement, HTMLDivElement>) => boolean }),
    scrollToFn: (offset, { adjustments, behavior }) => {
      const stream = streamRef.current;
      if (!stream) return;
      const target = offset + (adjustments ?? 0);
      const before = stream.scrollTop;
      stream.scrollTo({ top: target, behavior: behavior ?? 'auto' });
      // Register the offset the browser actually landed on, not the
      // requested target: a target past the scrollable maximum is clamped
      // by the browser, and an echo measured against the unclamped target
      // would not be recognized as compensation. A write that moved
      // nothing emits no scroll event, so it must not leave a stale
      // marker behind for the next genuine gesture to trip over.
      if (behavior !== 'smooth' && stream.scrollTop !== before) {
        restoredScrollTopRef.current = stream.scrollTop;
      }
      // Credit the block anchor synchronously: scroll events are
      // dispatched after both this write and any same-task settle have
      // already run, so an event-based credit can arrive too late and
      // the settle would pay the same shift a second time.
      if (stream.scrollTop !== before) blockCompensatedRef.current += stream.scrollTop - before;
    },
    enabled: virtualWanted
  });
  virtualizerRef.current = virtualizer;
  const captureVirtualKeyAnchor = (stream: HTMLDivElement, below = false): KeyAnchor | null => {
    const instance = virtualizerRef.current;
    const items = instance?.getVirtualItems() ?? [];
    if (!instance || items.length === 0) return null;
    const scrollTop = stream.scrollTop;
    const item = below
      ? items.find(candidate => candidate.start >= scrollTop) ?? items[items.length - 1]!
      : items.find(candidate => candidate.end > scrollTop) ?? items[0]!;
    return { key: String(item.key), offsetWithin: scrollTop - item.start };
  };
  const virtualItems = virtualActive ? virtualizer.getVirtualItems() : [];
  // The scroll container only exists after the first content commit, and
  // the virtualizer needs one passive pass to observe its rect. Engage
  // virtualization once a real viewport exists; until then (and in static
  // markup) the legacy full render below is used unchanged.
  useEffect(() => {
    if (virtualWanted && !virtualActive && streamRef.current && streamRef.current.clientHeight > 0) {
      setVirtualActive(true);
    }
  });
  useLayoutEffect(() => {
    if (!virtualActive) return;
    if (stickToBottomRef.current && !viewingHistory) followLatest();
    else restoreReadingPosition();
  }, [virtualActive]);
  const measuredThreadRef = useRef(threadId);
  useEffect(() => {
    keyAnchorRef.current = null;
    blockAnchorRef.current = null;
    blockSettleVersionRef.current += 1;
    if (measuredThreadRef.current === threadId) return;
    measuredThreadRef.current = threadId;
    virtualizerRef.current?.measure();
  }, [threadId]);
  // Range-driven replacement for the later sentinel's IntersectionObserver:
  // once the mounted range reaches the last retained row, run the same
  // gated later-page load the observer used to trigger.
  const lastVirtualIndex = virtualItems.length ? virtualItems[virtualItems.length - 1]!.index : -1;
  useEffect(() => {
    if (virtualActive && hasNewerHistory && lastVirtualIndex >= 0 && lastVirtualIndex >= rows.length - 1) {
      loadLaterRef.current();
    }
  }, [virtualActive, hasNewerHistory, lastVirtualIndex, rows.length]);

  const alignNavigationTarget = useCallback(() => {
    const stream = streamRef.current;
    const key = navigationAnchorRef.current;
    if (!stream || !key) return;
    const node = [...(innerRef.current?.querySelectorAll<HTMLElement>('[data-user-key]') ?? [])]
      .find(node => node.dataset.userKey === key);
    if (node) stream.scrollTop += node.getBoundingClientRect().top - stream.getBoundingClientRect().top - 24;
  }, []);
  const navigate = useCallback(async (target: NavigationTarget) => {
    setNavigationContext(true);
    earlierBoundaryRef.current = null;
    continuationTopRef.current = null;
    onCancelHistoryReveal?.();
    innerRef.current?.style.removeProperty('--reading-tail');
    const version = ++navigationVersionRef.current;
    navigatingRef.current = true;
    stickToBottomRef.current = false;
    readingAnchorRef.current = null;
    blockAnchorRef.current = null;
    blockSettleVersionRef.current += 1;
    anchorSettleVersionRef.current += 1;
    historySettleRef.current = false;
    const key = itemKey({ turnId: target.turnId, id: target.itemId });
    navigationAnchorRef.current = key;
    const find = () => [...(innerRef.current?.querySelectorAll<HTMLElement>('[data-user-key]') ?? [])]
      .find(node => node.dataset.userKey === key);
    const inRows = virtualActiveRef.current && rowsRef.current.some(row => row.section?.user &&
      row.section.entries[0]?.type === 'message' &&
      itemKey((row.section.entries[0] as Extract<TimelineEntry, { type: 'message' }>).item) === key);
    if (!inRows && !find() && onRevealHistory) await onRevealHistory(target.turnId, target.itemId);
    if (version !== navigationVersionRef.current) return;
    requestAnimationFrame(() => {
      if (version !== navigationVersionRef.current) return;
      const stream = streamRef.current;
      if (virtualActiveRef.current && stream) {
        // The target row may be unmounted: bring it into the mounted range
        // by index, then let the DOM align converge on the measured row
        // (the inner ResizeObserver keeps re-aligning while measurements
        // settle, all under navigatingRef so scroll handling stays out).
        const index = rowsRef.current.findIndex(row => row.section?.user &&
          row.section.entries[0]?.type === 'message' &&
          itemKey((row.section.entries[0] as Extract<TimelineEntry, { type: 'message' }>).item) === key);
        if (index >= 0) {
          virtualizerRef.current?.scrollToIndex(index, { align: 'start' });
          setAwayFromBottom(true);
          requestAnimationFrame(() => {
            if (version !== navigationVersionRef.current) return;
            alignNavigationTarget();
            requestAnimationFrame(() => { if (version === navigationVersionRef.current) navigatingRef.current = false; });
          });
          return;
        }
      }
      const node = find();
      if (node && stream) {
        alignNavigationTarget();
        setAwayFromBottom(true);
      }
      requestAnimationFrame(() => { if (version === navigationVersionRef.current) navigatingRef.current = false; });
    });
  }, [onRevealHistory, onCancelHistoryReveal, alignNavigationTarget]);
  const handleNavigate = useCallback((target: NavigationTarget) => { void navigate(target); }, [navigate]);
  useEffect(() => {
    const stream = streamRef.current;
    const sentinel = laterSentinelRef.current;
    if (!stream || !hasNewerHistory || !onLoadLater || (!virtualActive && !sentinel)) {
      loadLaterRef.current = () => {};
      return;
    }
    let frame = 0;
    const load = () => {
      // A window barely taller than the viewport is permanently within
      // range of its own end; passive triggers (sentinel, scroll events
      // from anchor restoration) must not page later from its top. Only
      // travel towards the end, or a just-made downward gesture, may.
      const travelledToEnd = stream.scrollTop > stream.clientHeight * 0.5 ||
        performance.now() - forwardIntentRef.current < 1500;
      if (loadingLaterHistory || loadingHistory || revealingHistory || laterPendingRef.current ||
          !navigator.onLine || document.visibilityState !== 'visible' ||
          !laterHistoryLoadReady(stream.scrollHeight - stream.scrollTop - stream.clientHeight,
            stream.clientHeight, wantsEarlierRef.current, travelledToEnd)) return;
      const key = `${newerHistoryCursor}:${items.length}:${items.at(-1) ? itemKey(items.at(-1)!) : ''}`;
      if (laterAttemptRef.current === key) return;
      laterAttemptRef.current = key;
      laterPendingRef.current = true;
      void onLoadLater(async () => {
        if (!mountedRef.current || !await scrollActivityRef.current!.waitForIdle()) return false;
        if (!mountedRef.current || navigatingRef.current || navigationAnchorRef.current ||
            document.visibilityState !== 'visible') return false;
        const inner = innerRef.current;
        if (inner && !stickToBottomRef.current) readingAnchorRef.current = captureReadingAnchor(stream, inner);
        return true;
      }).catch(error => onActionError?.(error)).finally(() => {
        laterPendingRef.current = false;
        // React can commit the new cursor before this promise settles.
        // Recheck the current page, whose attempt key prevents idle retries.
        frame = requestAnimationFrame(() => loadLaterRef.current());
      });
    };
    loadLaterRef.current = load;
    const recover = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || laterPendingRef.current) return;
      laterAttemptRef.current = null;
      load();
    };
    // Virtual mode renders no in-flow sentinel to observe; the range
    // effect above calls load() when the mounted range reaches the last
    // row instead. Every other trigger and the load gate are unchanged.
    const observer = !virtualActive && sentinel ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load();
    }, { root: stream, rootMargin: `0px 0px ${Math.round(stream.clientHeight * 0.5)}px 0px` }) : null;
    if (observer && sentinel) observer.observe(sentinel);
    stream.addEventListener('scroll', load, { passive: true });
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    load();
    return () => {
      observer?.disconnect();
      stream.removeEventListener('scroll', load);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
      cancelAnimationFrame(frame);
      loadLaterRef.current = () => {};
    };
  }, [hasNewerHistory, newerHistoryCursor, onLoadLater, items, loadingLaterHistory, loadingHistory, revealingHistory, onActionError, virtualActive]);
  const rememberReadingPosition = useCallback(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    readingAnchorRef.current = stream && inner && !stickToBottomRef.current
      ? captureReadingAnchor(stream, inner) : null;
    // The block anchor locks the concrete block at the reader's eye line
    // so layout growth inside its own section — invisible to both the
    // container anchor above and the keyed row anchor below — can still
    // be compensated once scrolling settles. While a settle is pending
    // the anchor belongs to that settle: recapturing here would baseline
    // it onto already-shifted geometry and erase the drift it must fix.
    if (!blockSettlePendingRef.current && !virtualActiveRef.current) {
      blockAnchorRef.current = stream && inner && !stickToBottomRef.current
        ? captureBlockAnchor(stream, inner) : null;
      blockCompensatedRef.current = 0;
    } else if (!blockSettlePendingRef.current && virtualActiveRef.current) {
      // The keyed row anchor owns history prepends in virtual mode. Capturing
      // a DOM block here would let its idle settle race the retained-row
      // compensation and subtract the browser's own scroll adjustment again.
      // Activity expansion still captures its block anchor explicitly in
      // preserveActivityPosition.
      blockAnchorRef.current = null;
      blockCompensatedRef.current = 0;
    }
    // The keyed anchor mirrors the DOM anchor but survives the anchored
    // row being unmounted by the virtual window or shifted by a prepend.
    keyAnchorRef.current = virtualActiveRef.current && stream && !stickToBottomRef.current
      ? captureVirtualKeyAnchor(stream) : null;
    virtualRestoreAttemptsRef.current = 0;
  }, []);
  // In-row compensation is submitted only at the HistoryScroll idle
  // point: during a drag or its momentum the block's displacement is left
  // alone, and at settle time only the residual the row-level restores
  // did not already cover is written, so the two layers never stack.
  const settleBlockPosition = useCallback(() => {
    if (blockSettlePendingRef.current) return;
    blockSettlePendingRef.current = true;
    const version = blockSettleVersionRef.current;
    void scrollActivityRef.current!.waitForIdle().then(ready => {
      blockSettlePendingRef.current = false;
      if (!ready || version !== blockSettleVersionRef.current || !mountedRef.current) return;
      const stream = streamRef.current;
      const inner = innerRef.current;
      const anchor = blockAnchorRef.current;
      if (!stream || !inner || !anchor || stickToBottomRef.current ||
          navigatingRef.current || navigationAnchorRef.current) return;
      const { applied, blocked } = settleBlockAnchor(stream, inner, anchor, blockCompensatedRef.current);
      // A blocked debt keeps both its baseline and its credits: the next
      // resize (the virtual total catching up) retries the same amount.
      if (!blocked) blockCompensatedRef.current = 0;
      if (applied !== 0) blockSettleEchoRef.current = stream.scrollTop;
    });
  }, []);
  const followLatest = useCallback(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    if (!stream || !inner) return;
    releaseReadingTail(inner);
    setVirtualTailPx(0);
    readingAnchorRef.current = null;
    blockAnchorRef.current = null;
    blockSettleVersionRef.current += 1;
    anchorSettleVersionRef.current += 1;
    historySettleRef.current = false;
    stream.scrollTop = stream.scrollHeight;
    previousScrollTopRef.current = stream.scrollTop;
    onHistoryReading?.(threadId, false);
  }, [onHistoryReading, threadId]);
  const releaseTailAfterReading = useCallback(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    if (!stream || !inner) return;
    const released = releaseReadingTail(inner);
    if (virtualActiveRef.current) setVirtualTailPx(0);
    if (!released && !virtualActiveRef.current) return;
    // Removing obsolete space may clamp scrollTop. It is not an upward gesture.
    previousScrollTopRef.current = stream.scrollTop;
    restoredScrollTopRef.current = stream.scrollTop;
    rememberReadingPosition();
  }, [rememberReadingPosition]);
  const restoreReadingPosition = useCallback(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    if (virtualActiveRef.current && stream) {
      // The virtual list always lays out the full retained geometry, so
      // the DOM restore's reading-tail space is never needed — and if one
      // was left over it inflates scrollHeight beyond the real content,
      // poisoning every distance the scroll logic derives from it. The
      // keyed anchor replaces the DOM restore entirely in this mode: it
      // resolves even while the anchored row is unmounted, and lands the
      // scroll offset on the measured row start plus the in-row offset.
      if (inner && (stickToBottomRef.current || !keyAnchorRef.current)) releaseReadingTail(inner);
      if (keyAnchorRef.current && !stickToBottomRef.current && !navigationAnchorRef.current) {
        const anchor = keyAnchorRef.current;
        // A keyed history-prepend restore owns this layout change. Detach the
        // interaction block anchor so its later resize settle cannot subtract
        // the row compensation a second time or invalidate the kept row.
        blockAnchorRef.current = null;
        blockSettleVersionRef.current += 1;
        const anchorIndex = rowsRef.current.findIndex(row => row.key === anchor.key);
        const retry = () => {
          if (virtualRestoreFrameRef.current || virtualRestoreAttemptsRef.current >= 6) return;
          virtualRestoreAttemptsRef.current += 1;
          virtualRestoreGuardUntilRef.current = performance.now() + 250;
          virtualRestoreFrameRef.current = requestAnimationFrame(() => {
            virtualRestoreFrameRef.current = 0;
            restoreReadingPositionRef.current();
          });
        };
        if (anchorIndex < 0) {
          virtualRestoreAttemptsRef.current = 0;
        } else {
          const row = inner?.querySelector<HTMLElement>(`.timeline-row[data-index="${anchorIndex}"]`);
          if (!row) {
            // The retained row may be outside the mounted range after a
            // prepend. Bring it back first, then settle its exact offset from
            // the rendered wrapper instead of trusting stale virtual offsets.
            virtualizerRef.current?.scrollToIndex(anchorIndex, { align: 'start' });
            retry();
            return;
          }
          const paddingTop = parseFloat(getComputedStyle(stream).paddingTop) || 0;
          const desiredTop = stream.getBoundingClientRect().top + paddingTop - anchor.offsetWithin;
          const delta = row.getBoundingClientRect().top - desiredTop;
          if (Math.abs(delta) > .5) {
            const before = stream.scrollTop;
            virtualRestoreGuardUntilRef.current = performance.now() + 250;
            // A window whose whole geometry fits the viewport has
            // exactly one position that shows it all: the top. A
            // remembered in-row offset captured against a taller
            // geometry (a thread's first page at open, priced from a
            // stale anchor measurement) cannot apply here — chasing
            // it manufactures tail space and parks the reader in
            // empty space below the content. Scrollable windows keep
            // the bridging behaviour below untouched.
            if ((virtualizerRef.current?.getTotalSize() ?? 0) <= stream.clientHeight) {
              if (inner) releaseReadingTail(inner);
              setVirtualTailPx(0);
              stream.scrollTop = 0;
              restoredScrollTopRef.current = stream.scrollTop;
              virtualRestoreAttemptsRef.current = 0;
              return;
            }
            const target = Math.round(stream.scrollTop + delta);
            const maximum = Math.max(0, stream.scrollHeight - stream.clientHeight);
            const missingSpace = target - maximum;
            if (inner && missingSpace > .5) {
              const tail = parseFloat(inner.style.getPropertyValue('--reading-tail')) || 0;
              inner.style.setProperty('--reading-tail', `${tail + missingSpace}px`);
              setVirtualTailPx(previous => previous + missingSpace);
            }
            stream.scrollTop = target;
            restoredScrollTopRef.current = stream.scrollTop;
            blockCompensatedRef.current += stream.scrollTop - before;
          }
          if (Math.abs(delta) > .5) retry();
          else virtualRestoreAttemptsRef.current = 0;
        }
      }
      return;
    }
    const anchor = readingAnchorRef.current;
    if (stream && inner && anchor && !stickToBottomRef.current && !navigationAnchorRef.current) {
      const before = stream.scrollTop;
      if (restoreReadingAnchor(stream, inner, anchor)) {
        restoredScrollTopRef.current = stream.scrollTop;
        blockCompensatedRef.current += stream.scrollTop - before;
      }
    }
  }, []);
  restoreReadingPositionRef.current = restoreReadingPosition;
  // The deferred half of restoreReadingPosition: streaming-frequency
  // triggers (tail growth, resize observations, image loads, suppressed
  // size adjustments) coalesce into a single settle once scrolling goes
  // quiet, so a drag or its momentum never meets a scrollToIndex/rAF
  // retry storm. History commits never take this path — their restore
  // stays synchronous before paint (see the items effect below).
  const scheduleAnchorRestore = useCallback(() => {
    if (anchorSettlePendingRef.current) return;
    anchorSettlePendingRef.current = true;
    const version = anchorSettleVersionRef.current;
    void scrollActivityRef.current!.waitForIdle().then(ready => {
      anchorSettlePendingRef.current = false;
      if (!ready || version !== anchorSettleVersionRef.current || !mountedRef.current) return;
      if (navigatingRef.current || navigationAnchorRef.current) return;
      historySettleRef.current = false;
      restoreReadingPositionRef.current();
    });
  }, []);
  const preserveActivityPosition = useCallback(() => {
    earlierBoundaryRef.current = null;
    continuationTopRef.current = null;
    wantsEarlierRef.current = false;
    navigationAnchorRef.current = null;
    // onInteract fires before the toggle re-renders, so in virtual mode
    // capture the pre-interaction anchor here and let the resize-driven
    // restore hold the reader's place across the height change, instead
    // of discarding the anchor and recapturing after the shift. The keyed
    // anchor for interactions points at the first row below the fold:
    // growth in the rows above shifts that row's start by the full delta,
    // which the top-of-viewport anchor (possibly inside the growing row
    // itself) cannot express.
    if (virtualActiveRef.current) {
      rememberReadingPosition();
      const stream = streamRef.current;
      if (stream && !stickToBottomRef.current) {
        keyAnchorRef.current = captureVirtualKeyAnchor(stream, true)
          ?? keyAnchorRef.current;
      }
    }
    else readingAnchorRef.current = null;
    // The block anchor is captured unconditionally (even at the bottom,
    // where the reading anchors stand down): growth from this very
    // interaction lands inside the reader's own section, and only the
    // block at their eye line can prove how far it pushed their content.
    // It replaces any anchor remembered from scrolling — the interaction,
    // not the last scroll frame, defines what must be held.
    {
      const stream = streamRef.current;
      const inner = innerRef.current;
      if (stream && inner) {
        blockAnchorRef.current = captureBlockAnchor(stream, inner);
        blockCompensatedRef.current = 0;
      }
    }
    stickToBottomRef.current = false;
    onHistoryReading?.(threadId, true);
    window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (!stream) return;
      releaseTailAfterReading();
      const nearBottom = !loadingEarlierRef.current && !viewingHistory &&
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140;
      stickToBottomRef.current = nearBottom;
      onHistoryReading?.(threadId, !nearBottom);
      setAwayFromBottom(!nearBottom);
      // Queue the in-row settle before recapturing: the pending flag it
      // raises keeps the recapture from baselining the block anchor onto
      // the post-interaction geometry it exists to correct.
      settleBlockPosition();
      if (!virtualActiveRef.current) rememberReadingPosition();
    });
  }, [rememberReadingPosition, releaseTailAfterReading, settleBlockPosition, viewingHistory, onHistoryReading, threadId]);
  const atEarlierBoundary = () => {
    const top = streamRef.current?.scrollTop ?? Infinity;
    return top <= 64 || continuationTopRef.current !== null && top <= continuationTopRef.current + 1;
  };
  const loadEarlier = useCallback(() => {
    if (!navigator.onLine || document.visibilityState !== 'visible' || !hasMoreHistory || loadingEarlierRef.current || navigatingRef.current || navigationAnchorRef.current || revealingHistory) return;
    const attempt = JSON.stringify([threadId, items[0] ? itemKey(items[0]) : '', items.length]);
    if (earlierAttemptRef.current === attempt) return;
    earlierAttemptRef.current = attempt;
    stickToBottomRef.current = false;
    setAwayFromBottom(true);
    if (continuationTopRef.current === null) rememberReadingPosition();
    earlierBoundaryRef.current = items[0] ? itemKey(items[0]) : null;
    loadingEarlierRef.current = true;
    void onLoadEarlier(async () => {
      if (!mountedRef.current || !await scrollActivityRef.current!.waitForIdle()) return false;
      if (!mountedRef.current || document.visibilityState !== 'visible' || navigatingRef.current || navigationAnchorRef.current) return false;
      if (!wantsEarlierRef.current || !atEarlierBoundary()) {
        earlierAttemptRef.current = null;
        return false;
      }
      if (continuationTopRef.current === null) rememberReadingPosition();
      return true;
    }).finally(() => { loadingEarlierRef.current = false; });
  }, [hasMoreHistory, onLoadEarlier, revealingHistory, threadId, items, rememberReadingPosition]);
  const prefetchEarlier = useCallback(() => {
    if (!navigator.onLine || !hasMoreHistory || !onPrefetchEarlier || revealingHistory || navigatingRef.current) return;
    const attempt = JSON.stringify([threadId, items[0] ? itemKey(items[0]) : '', items.length]);
    if (prefetchAttemptRef.current === attempt) return;
    prefetchAttemptRef.current = attempt;
    void onPrefetchEarlier();
  }, [hasMoreHistory, onPrefetchEarlier, revealingHistory, threadId, items]);
  loadWhenIdleRef.current = () => {
    const stream = streamRef.current;
    // Every scroll idle point pays any size-compensation debt the
    // virtualizer predicate froze during the gesture, even when the
    // stream ended right after the suppressed measurement and no items,
    // resize or load event follows to trigger a settle of its own.
    if (sizeCompensationDeferredRef.current) {
      sizeCompensationDeferredRef.current = false;
      scheduleAnchorRestore();
    }
    // The history settle window ends at this idle point: from here on,
    // row-size changes are streaming growth again and the gesture
    // freeze governs them.
    historySettleRef.current = false;
    if (!wantsEarlierRef.current && !loadingEarlierRef.current && !navigationAnchorRef.current &&
        (!virtualActiveRef.current || performance.now() - forwardIntentRef.current < 1500)) {
      releaseTailAfterReading();
    }
    if (stream && !wantsEarlierRef.current && !viewingHistory && !loadingEarlierRef.current &&
      stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4) {
      stickToBottomRef.current = true;
      readingAnchorRef.current = null;
      setAwayFromBottom(false);
      onHistoryReading?.(threadId, false);
    }
    if (stream && wantsEarlierRef.current && atEarlierBoundary()) loadEarlier();
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(readingFrameRef.current);
      readingFrameRef.current = 0;
      earlierBoundaryRef.current = null;
      continuationTopRef.current = null;
      scrollActivityRef.current!.cancel();
      cancelAnimationFrame(virtualRestoreFrameRef.current);
      virtualRestoreFrameRef.current = 0;
      virtualRestoreAttemptsRef.current = 0;
      onHistoryReading?.(threadId, false);
    };
  }, [threadId]);

  useLayoutEffect(() => {
    if (navigatingRef.current || viewingHistory) { initialScrollReadyRef.current = true; return; }
    if (initialScrollReadyRef.current) return;
    if (loading && items.length === 0) return;
    stickToBottomRef.current = true;
    readingAnchorRef.current = null;
    followLatest();
    initialScrollReadyRef.current = true;
  }, [loading, threadId, viewingHistory, followLatest]);

  useEffect(() => () => {
    navigationVersionRef.current += 1;
    navigationAnchorRef.current = null;
    blockSettleVersionRef.current += 1;
    anchorSettleVersionRef.current += 1;
    historySettleRef.current = false;
    blockAnchorRef.current = null;
  }, [threadId]);

  useEffect(() => {
    const inner = innerRef.current;
    if (loading || !inner) return;
    const observer = new ResizeObserver(() => {
      if (navigationAnchorRef.current) { alignNavigationTarget(); return; }
      const stream = streamRef.current;
      if (stream && stickToBottomRef.current && !viewingHistory) followLatest();
      // In virtual mode a resize is a streaming-frequency trigger: route
      // it through the same idle-coalesced settle as tail growth instead
      // of a synchronous geometry pass per observation. The legacy
      // full-render path keeps its immediate restore unchanged.
      else if (virtualActiveRef.current) scheduleAnchorRestore();
      else restoreReadingPosition();
      settleBlockPosition();
    });
    observer.observe(inner);
    if (streamRef.current) observer.observe(streamRef.current);
    return () => observer.disconnect();
  }, [loading, threadId, viewingHistory, alignNavigationTarget, restoreReadingPosition, followLatest, settleBlockPosition, scheduleAnchorRestore]);

  useLayoutEffect(() => {
    if (loading) return;
    const stream = streamRef.current;
    if (!stream) return;
    if (stickToBottomRef.current && !viewingHistory) {
      followLatest();
      stickToBottomRef.current = true;
    }
  }, [items, loading, viewingHistory, followLatest]);

  useLayoutEffect(alignNavigationTarget, [items, turnTimings, alignNavigationTarget]);

  // Correct before paint, then keep the same item fixed as skipped content and images acquire real heights.
  // Timing/history transitions keep that synchronous restore: a history
  // commit must land before the browser paints, or the reader sees the
  // one-frame jump the history work eliminated.
  useLayoutEffect(restoreReadingPosition, [turnTimings, loadingHistory, restoreReadingPosition]);

  // Item changes split by shape. A changed head (an earlier page
  // commit, a window trim, a thread switch) or the landing of an
  // in-flight later-page load is a history commit and also restores
  // synchronously. A pure tail change in virtual mode is streaming
  // growth: it can only move the reader through row-size debt, which
  // the keyed anchor settles at the scroll idle point — never as a
  // per-flush geometry pass during a drag or its momentum. The legacy
  // full-render path keeps its immediate restore for every change.
  const previousItemsRef = useRef<ThreadItem[] | null>(null);
  // Whether a later-page load was in flight when the current commit
  // began: such a commit appends at the tail (the streaming shape) but
  // is a history commit and keeps the synchronous restore. Updated in
  // a passive effect so the layout effect below still reads the value
  // from the end of the previous commit.
  const laterLoadWasInFlightRef = useRef(false);
  useEffect(() => { laterLoadWasInFlightRef.current = loadingLaterHistory; }, [loadingLaterHistory]);
  useLayoutEffect(() => {
    const previous = previousItemsRef.current;
    previousItemsRef.current = items;
    if (!virtualActiveRef.current || previous === null || previous === items) {
      restoreReadingPosition();
      return;
    }
    const headChanged = previous.length === 0 || items.length < previous.length ||
      (previous[0] && items[0] ? itemKey(previous[0]) !== itemKey(items[0]) : previous[0] !== items[0]);
    if (headChanged || laterLoadWasInFlightRef.current) {
      historySettleRef.current = true;
      restoreReadingPosition();
    }
    else scheduleAnchorRestore();
  }, [items, restoreReadingPosition, scheduleAnchorRestore]);

  useLayoutEffect(() => {
    const boundary = earlierBoundaryRef.current;
    if (!boundary) return;
    const index = items.findIndex(item => itemKey(item) === boundary);
    if (index <= 0) return;
    earlierBoundaryRef.current = null;
    const readableKeys = new Set(items.slice(0, index).filter(isReadableHistoryItem).map(itemKey));
    const revealed = [...(innerRef.current?.querySelectorAll<HTMLElement>('.message[data-scroll-anchor]') ?? [])]
      .some(node => readableKeys.has(node.dataset.scrollAnchor!));
    if (revealed) {
      continuationTopRef.current = null;
      wantsEarlierRef.current = false;
    } else if (wantsEarlierRef.current && streamRef.current) {
      // Folded/hidden records must not require another gesture just because
      // restoring the reading anchor moved scrollTop away from the sentinel.
      continuationTopRef.current = streamRef.current.scrollTop;
    }
  }, [items]);

  useEffect(() => {
    if (!loadingHistory) loadingEarlierRef.current = false;
  }, [loadingHistory]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (!loading && !loadingHistory && stream && !navigationAnchorRef.current) {
        if (stream.scrollTop < stream.clientHeight * 2) prefetchEarlier();
        if (wantsEarlierRef.current && atEarlierBoundary()) scrollActivityRef.current!.activity();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [items.length, loading, loadingHistory, prefetchEarlier]);

  if (loading && items.length === 0 && !Object.values(turnTimings).some(turn => turn.error)) {
    return (
      <div className="message-stream message-stream--loading" aria-label="正在加载任务">
        <div className="message-skeleton message-skeleton--short" />
        <div className="message-skeleton message-skeleton--long" />
        <div className="message-skeleton message-skeleton--medium" />
      </div>
    );
  }

  const snapshotNotice = snapshotState && <div className="history-snapshot-status" role="status">
    {snapshotState === 'loading' && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
    <span>{snapshotState === 'loading' ? '正在同步会话记录，当前内容可能不完整' : '会话记录尚未同步完成'}</span>
    {snapshotState === 'failed' && onRetrySnapshot && <button type="button" className="icon-button"
      aria-label="重试同步会话记录" title="重试同步会话记录" onClick={onRetrySnapshot}>
      <RotateCw size={15} aria-hidden="true" />
    </button>}
  </div>;
  if (items.length === 0 && !emptyError?.error) {
    if (snapshotNotice) return <div className="message-stream message-stream--empty">{snapshotNotice}</div>;
    return (
      <div className="message-stream message-stream--empty">
        <div className="empty-thread-icon">
          <MessageSquareText size={22} aria-hidden="true" />
        </div>
        <h2>从第一条消息开始</h2>
      </div>
    );
  }

  const renderSection = (section: TimelineSection, index: number) => section.user
    ? <Fragment key={section.key}>
      <MessageItem item={(section.entries[0] as Extract<TimelineEntry, { type: 'message' }>).item}
        showFull={navigationContext || viewingHistory}
        onEdit={(section.entries[0] as Extract<TimelineEntry, { type: 'message' }>).item.id === editableMessageId
          ? onEditMessage : undefined} />
      {section.turnId && turnTimings[section.turnId]?.error && !sections.some(other => !other.user && other.turnId === section.turnId) &&
        !sections.slice(index + 1).some(other => other.turnId === section.turnId) &&
        <NativeTurnError turn={turnTimings[section.turnId]} />}
    </Fragment>
    : <ResponseSection section={section} timing={section.turnId ? turnTimings[section.turnId] : undefined}
        finalStartedAtMs={responses.get(section.turnId ?? '')?.finalStartedAtMs ?? null}
        finalAnswer={responses.get(section.turnId ?? '')?.finalAnswer}
        hasTrace={responses.get(section.turnId ?? '')?.hasTrace ?? false}
        showError={responses.get(section.turnId ?? '')?.lastResponseKey === section.key}
        open={expandedTurns.has(section.turnId ?? '')} onToggleTurn={toggleTurn}
        active={section.turnId === activeTurnId} threadIdle={threadIdle}
         heartbeatTurn={heartbeatTurns.has(section.turnId ?? '')}
        onInteract={preserveActivityPosition} key={section.key}
        onFork={onFork} onError={onActionError} />;
  const renderTailRow = (turnId: string) => (
    <div className="turn-response"><div className="worked-divider">
      <TurnDuration timing={turnTimings[turnId]} active />
    </div></div>
  );
  const cancelVirtualRestore = () => {
    cancelAnimationFrame(virtualRestoreFrameRef.current);
    virtualRestoreFrameRef.current = 0;
    virtualRestoreAttemptsRef.current = 0;
    virtualRestoreGuardUntilRef.current = 0;
    // Every reader-takeover signal funnels through here (wheel, touch,
    // keys, pointer, scroll-to-top), so it must also void a pending
    // idle anchor settle: the settle is the deferred half of the same
    // restore, and letting it fire after a takeover drags the reader
    // back to the pre-takeover anchor — the exact fight the cancel
    // exists to prevent.
    anchorSettleVersionRef.current += 1;
    anchorSettlePendingRef.current = false;
    historySettleRef.current = false;
  };

  return (
    <HistoryThreadContext.Provider value={threadId}>
    <div className="timeline-shell">
    {snapshotNotice}
    <ThreadNavigation turns={outlineTurns} streamRef={streamRef} innerRef={innerRef}
      busy={revealingHistory} error={outlineError} onNavigate={handleNavigate} />
    <div
      ref={streamRef}
      className="message-stream"
      aria-label="会话记录"
      onWheel={event => {
        cancelVirtualRestore();
        if (!laterPendingRef.current) laterAttemptRef.current = null;
        navigationAnchorRef.current = null;
        wantsEarlierRef.current = event.deltaY < 0;
        if (event.deltaY > 0) forwardIntentRef.current = performance.now();
        if (event.deltaY < 0) onHistoryReading?.(threadId, true);
        if (!wantsEarlierRef.current) continuationTopRef.current = null;
        if (event.deltaY < 0 && !loadingEarlierRef.current) earlierAttemptRef.current = null;
        // Direction is settled before later paging is reconsidered, so an
        // upward gesture can never trigger a newer page.
        loadLaterRef.current();
        scrollActivityRef.current!.activity();
      }}
      onTouchStart={event => {
        cancelVirtualRestore();
        if (!laterPendingRef.current) laterAttemptRef.current = null;
        loadLaterRef.current();
        navigationAnchorRef.current = null;
        scrollActivityRef.current!.startTouch(event.touches[0]?.clientY ?? null);
        stickToBottomRef.current = false;
        onHistoryReading?.(threadId, true);
        rememberReadingPosition();
      }}
      onTouchMove={event => {
        const direction = scrollActivityRef.current!.moveTouch(event.touches[0]?.clientY ?? null);
        if (direction !== null) {
          wantsEarlierRef.current = direction < 0;
          if (direction > 0) forwardIntentRef.current = performance.now();
          if (!wantsEarlierRef.current) continuationTopRef.current = null;
          if (wantsEarlierRef.current && !loadingEarlierRef.current) earlierAttemptRef.current = null;
        }
      }}
      onTouchEnd={() => { scrollActivityRef.current!.endTouch(); }}
      onTouchCancel={() => { scrollActivityRef.current!.endTouch(); }}
      onPointerDownCapture={() => { cancelVirtualRestore(); navigationAnchorRef.current = null; }}
      onKeyDownCapture={event => {
        navigationAnchorRef.current = null;
        if (['Home', 'PageUp', 'ArrowUp', 'End', 'PageDown', 'ArrowDown'].includes(event.key)) {
          cancelVirtualRestore();
          if (!laterPendingRef.current) laterAttemptRef.current = null;
          wantsEarlierRef.current = ['Home', 'PageUp', 'ArrowUp'].includes(event.key);
          if (!wantsEarlierRef.current) forwardIntentRef.current = performance.now();
          if (!wantsEarlierRef.current) continuationTopRef.current = null;
          if (wantsEarlierRef.current && !loadingEarlierRef.current) earlierAttemptRef.current = null;
          loadLaterRef.current();
          scrollActivityRef.current!.activity();
        }
      }}
      onLoadCapture={() => {
        if (navigationAnchorRef.current) { alignNavigationTarget(); return; }
        const stream = streamRef.current;
        if (stream && stickToBottomRef.current && !viewingHistory) followLatest();
        else if (virtualActiveRef.current) { scheduleAnchorRestore(); settleBlockPosition(); }
        else { restoreReadingPosition(); settleBlockPosition(); }
      }}
      onScroll={(event) => {
        if (!initialScrollReadyRef.current || navigatingRef.current) return;
        const stream = event.currentTarget;
        if (stream.scrollTop <= 1) cancelVirtualRestore();
        // Layout compensation emits scroll too; it must not replace the reader's anchor.
        const restored = restoredScrollTopRef.current;
        restoredScrollTopRef.current = null;
        const blockEcho = blockSettleEchoRef.current;
        blockSettleEchoRef.current = null;
        // Safari's rubber-band return is not a change in the reader's direction.
        const delta = historyScrollDelta(previousScrollTopRef.current, stream.scrollTop,
          stream.scrollHeight - stream.clientHeight);
        previousScrollTopRef.current = stream.scrollTop;
        // Compensation echoes (either layer's) are not gestures; their
        // amounts were already credited synchronously at the write sites.
        if (restored !== null && Math.abs(stream.scrollTop - restored) < 1) return;
        if (blockEcho !== null && Math.abs(stream.scrollTop - blockEcho) < 1) return;
        if (performance.now() < virtualRestoreGuardUntilRef.current &&
            keyAnchorRef.current && Math.abs(delta) > .5) return;
        // A genuine scroll means the reader took over: a pending block
        // settle anchored before the gesture must not pay out afterwards
        // and drag them back to a block they scrolled away from.
        if (Math.abs(delta) > .5) blockSettleVersionRef.current += 1;
        // Touch intent owns the drag and momentum, including delayed rounding corrections.
        if (Math.abs(delta) > .5 && !scrollActivityRef.current!.hasTouchIntent) {
          wantsEarlierRef.current = delta < 0;
          if (!wantsEarlierRef.current) continuationTopRef.current = null;
          if (wantsEarlierRef.current && !loadingEarlierRef.current) earlierAttemptRef.current = null;
        }
        scrollActivityRef.current!.activity();
        stickToBottomRef.current =
          !loadingEarlierRef.current && !viewingHistory && !wantsEarlierRef.current &&
          stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4;
        onHistoryReading?.(threadId, !stickToBottomRef.current);
        setAwayFromBottom(!stickToBottomRef.current);
        if (!readingFrameRef.current) readingFrameRef.current = requestAnimationFrame(() => {
          readingFrameRef.current = 0;
          rememberReadingPosition();
        });
        if (!navigationAnchorRef.current && stream.scrollTop < stream.clientHeight * 2) prefetchEarlier();
      }}
    >
      {virtualActive ? (
      <div className="message-stream-inner message-stream-inner--virtual" ref={innerRef}
        style={{ height: virtualizer.getTotalSize() + virtualTailPx }}>
      {hasMoreHistory && (
        <div className="history-sentinel history-sentinel--virtual-top" data-history-sentinel aria-busy={loadingHistory}>
          {loadingHistory && <LoaderCircle size={15} className="spin" role="status" aria-label="正在加载更早记录" />}
        </div>
      )}
      {virtualItems.map(item => {
        const row = rows[item.index]!;
        return (
          <div className="timeline-row" key={item.key} data-index={item.index} ref={virtualizer.measureElement}
            style={{ transform: `translateY(${item.start}px)` }}>
            {row.section ? renderSection(row.section, row.sectionIndex)
              : row.notice ? <NativeTurnError turn={emptyError!} />
              : renderTailRow(activeTurnId!)}
          </div>
        );
      })}
      {hasNewerHistory && (
        <div className="history-sentinel history-sentinel--virtual-bottom" aria-busy={loadingLaterHistory}
          style={{ transform: `translateY(${Math.max(0, virtualizer.getTotalSize() - 52)}px)` }}>
          {loadingLaterHistory && <LoaderCircle size={15} className="spin" role="status" aria-label="正在加载后续记录" />}
        </div>
      )}
      </div>
      ) : (
      <div className="message-stream-inner" ref={innerRef}>
      {hasMoreHistory && (
        <div className="history-sentinel" data-history-sentinel aria-busy={loadingHistory}>
          {loadingHistory && <LoaderCircle size={15} className="spin" role="status" aria-label="正在加载更早记录" />}
        </div>
      )}
      {sections.map(renderSection)}
      {emptyError?.error && <NativeTurnError turn={emptyError} />}
      {!viewingHistory && activeTurnId && !sections.some((section) => !section.user && section.turnId === activeTurnId) &&
        renderTailRow(activeTurnId)}
      {hasNewerHistory && <div ref={laterSentinelRef} className="history-sentinel" aria-busy={loadingLaterHistory}>
        {loadingLaterHistory && <LoaderCircle size={15} className="spin" role="status" aria-label="正在加载后续记录" />}
      </div>}
      </div>
      )}
    </div>
    {(awayFromBottom || viewingHistory) && (
      <button
        type="button"
        className="jump-to-latest icon-button"
        aria-label="回到最新消息"
        title="回到最新消息"
        onClick={() => {
          earlierBoundaryRef.current = null;
          continuationTopRef.current = null;
          wantsEarlierRef.current = false;
          navigationVersionRef.current += 1;
          innerRef.current?.style.removeProperty('--reading-tail');
          navigatingRef.current = false;
          navigationAnchorRef.current = null;
          readingAnchorRef.current = null;
          if (viewingHistory && onReturnToLatest) { void onReturnToLatest(); return; }
          followLatest();
          stickToBottomRef.current = true;
          setAwayFromBottom(false);
        }}
      >
        <ArrowDown size={17} />
      </button>
    )}
    </div>
    </HistoryThreadContext.Provider>
  );
}
