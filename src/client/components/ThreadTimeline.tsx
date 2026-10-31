import { ArrowDown, LoaderCircle, MessageSquareText } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HistoryThreadContext } from '../history-details';
import { itemKey } from '../remote-state';
import type { ThreadItem } from '../types';
import { buildTimelineEntries, buildTimelineSections, type TimelineEntry, type TimelineSection } from '../timeline-model';
import type { TurnTiming } from '../../shared/turn-timing';
import type { OutlineTurn } from '../../shared/thread-outline';
import { ThreadNavigation, type NavigationTarget } from './ThreadNavigation';
import { captureReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from '../reading-anchor';
import { HistoryScroll, historyScrollDelta, type BeforeHistoryCommit } from '../history-scroll';
import { isReadableHistoryItem } from '../history-prefetch';
import { NativeTurnError } from './NativeTurnError';
import { ResponseSection, MessageItem, TurnDuration } from './TurnResponse';
export { MarkdownText } from './MarkdownText';

interface ThreadTimelineProps {
  threadId: string;
  items: ThreadItem[];
  loading: boolean;
  activeTurnId: string | null;
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
  onLoadLater?: () => Promise<void>;
  onRevealHistory?: (turnId: string, itemId: string) => Promise<boolean>;
  onCancelHistoryReveal?: () => void;
  onReturnToLatest?: () => Promise<void>;
  onFork?: (turnId: string) => Promise<void>;
  onActionError?: (error: unknown) => void;
}

export function ThreadTimeline({
  threadId,
  items,
  loading,
  activeTurnId,
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
  onFork,
  onActionError
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
  const restoredScrollTopRef = useRef<number | null>(null);
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
  const loadLaterRef = useRef<() => void>(() => {});
  const previousSectionsRef = useRef<TimelineSection[]>([]);
  const entries = useMemo(() => buildTimelineEntries(items, activeTurnId,
    previousSectionsRef.current.flatMap(section => section.entries)), [items, activeTurnId]);
  const sections = useMemo(() => buildTimelineSections(entries, previousSectionsRef.current), [entries]);
  useLayoutEffect(() => { previousSectionsRef.current = sections; }, [sections]);
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
    const key = itemKey({ turnId: target.turnId, id: target.itemId });
    navigationAnchorRef.current = key;
    const find = () => [...(innerRef.current?.querySelectorAll<HTMLElement>('[data-user-key]') ?? [])]
      .find(node => node.dataset.userKey === key);
    if (!find() && onRevealHistory) await onRevealHistory(target.turnId, target.itemId);
    if (version !== navigationVersionRef.current) return;
    requestAnimationFrame(() => {
      if (version !== navigationVersionRef.current) return;
      const node = find();
      const stream = streamRef.current;
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
    if (!stream || !sentinel || !hasNewerHistory || !onLoadLater) {
      loadLaterRef.current = () => {};
      return;
    }
    let frame = 0;
    const load = () => {
      if (loadingLaterHistory || loadingHistory || revealingHistory || laterPendingRef.current ||
          !navigator.onLine || document.visibilityState !== 'visible' ||
          stream.scrollHeight - stream.scrollTop - stream.clientHeight > stream.clientHeight * 2) return;
      const key = `${newerHistoryCursor}:${items.length}:${items.at(-1) ? itemKey(items.at(-1)!) : ''}`;
      if (laterAttemptRef.current === key) return;
      laterAttemptRef.current = key;
      laterPendingRef.current = true;
      void onLoadLater().catch(error => onActionError?.(error)).finally(() => {
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
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); },
      { root: stream, rootMargin: `0px 0px ${stream.clientHeight * 2}px 0px` });
    observer.observe(sentinel);
    stream.addEventListener('scroll', load, { passive: true });
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    load();
    return () => {
      observer.disconnect();
      stream.removeEventListener('scroll', load);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
      cancelAnimationFrame(frame);
      loadLaterRef.current = () => {};
    };
  }, [hasNewerHistory, newerHistoryCursor, onLoadLater, items, loadingLaterHistory, loadingHistory, revealingHistory, onActionError]);
  const rememberReadingPosition = useCallback(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    readingAnchorRef.current = stream && inner && !stickToBottomRef.current
      ? captureReadingAnchor(stream, inner) : null;
  }, []);
  const restoreReadingPosition = useCallback(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    const anchor = readingAnchorRef.current;
    if (stream && inner && anchor && !stickToBottomRef.current && !navigationAnchorRef.current) {
      if (restoreReadingAnchor(stream, inner, anchor)) restoredScrollTopRef.current = stream.scrollTop;
    }
  }, []);
  const preserveActivityPosition = useCallback(() => {
    earlierBoundaryRef.current = null;
    continuationTopRef.current = null;
    wantsEarlierRef.current = false;
    navigationAnchorRef.current = null;
    readingAnchorRef.current = null;
    stickToBottomRef.current = false;
    window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (!stream) return;
      const nearBottom = !loadingEarlierRef.current && !viewingHistory &&
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140;
      stickToBottomRef.current = nearBottom;
      setAwayFromBottom(!nearBottom);
      rememberReadingPosition();
    });
  }, [rememberReadingPosition, viewingHistory]);
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
    if (stream && !wantsEarlierRef.current && !viewingHistory && !loadingEarlierRef.current &&
      stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4) stickToBottomRef.current = true;
    if (stream && wantsEarlierRef.current && atEarlierBoundary()) loadEarlier();
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      earlierBoundaryRef.current = null;
      continuationTopRef.current = null;
      scrollActivityRef.current!.cancel();
    };
  }, [threadId]);

  useLayoutEffect(() => {
    if (navigatingRef.current || viewingHistory) { initialScrollReadyRef.current = true; return; }
    if (initialScrollReadyRef.current) return;
    if (loading && items.length === 0) return;
    stickToBottomRef.current = true;
    readingAnchorRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
      previousScrollTopRef.current = stream.scrollTop;
    }
    initialScrollReadyRef.current = true;
  }, [loading, threadId, viewingHistory]);

  useEffect(() => () => {
    navigationVersionRef.current += 1;
    navigationAnchorRef.current = null;
  }, [threadId]);

  useEffect(() => {
    const inner = innerRef.current;
    if (loading || !inner) return;
    const observer = new ResizeObserver(() => {
      if (navigationAnchorRef.current) { alignNavigationTarget(); return; }
      const stream = streamRef.current;
      if (stream && stickToBottomRef.current && !viewingHistory) stream.scrollTop = stream.scrollHeight;
      else restoreReadingPosition();
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [loading, threadId, viewingHistory, alignNavigationTarget, restoreReadingPosition]);

  useLayoutEffect(() => {
    if (loading) return;
    const stream = streamRef.current;
    if (!stream) return;
    if (stickToBottomRef.current && !viewingHistory) {
      stream.scrollTop = stream.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [items, loading, viewingHistory]);

  useLayoutEffect(alignNavigationTarget, [items, turnTimings, alignNavigationTarget]);

  // Correct before paint, then keep the same item fixed as skipped content and images acquire real heights.
  useLayoutEffect(restoreReadingPosition, [items, turnTimings, loadingHistory, restoreReadingPosition]);

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

  const emptyError = items.length === 0 ? turnTimings[activeTurnId ?? ''] ??
    Object.values(turnTimings).find(turn => turn.error) : undefined;
  if (items.length === 0 && !emptyError?.error) {
    return (
      <div className="message-stream message-stream--empty">
        <div className="empty-thread-icon">
          <MessageSquareText size={22} aria-hidden="true" />
        </div>
        <h2>从第一条消息开始</h2>
      </div>
    );
  }

  return (
    <HistoryThreadContext.Provider value={threadId}>
    <div className="timeline-shell">
    <ThreadNavigation turns={outlineTurns} streamRef={streamRef} innerRef={innerRef}
      busy={revealingHistory} error={outlineError} onNavigate={handleNavigate} />
    <div
      ref={streamRef}
      className="message-stream"
      aria-label="会话记录"
      onWheel={event => {
        if (!laterPendingRef.current) laterAttemptRef.current = null;
        loadLaterRef.current();
        navigationAnchorRef.current = null;
        wantsEarlierRef.current = event.deltaY < 0;
        if (!wantsEarlierRef.current) continuationTopRef.current = null;
        if (event.deltaY < 0 && !loadingEarlierRef.current) earlierAttemptRef.current = null;
        scrollActivityRef.current!.activity();
      }}
      onTouchStart={event => {
        if (!laterPendingRef.current) laterAttemptRef.current = null;
        loadLaterRef.current();
        navigationAnchorRef.current = null;
        scrollActivityRef.current!.startTouch(event.touches[0]?.clientY ?? null);
        stickToBottomRef.current = false;
        rememberReadingPosition();
      }}
      onTouchMove={event => {
        const direction = scrollActivityRef.current!.moveTouch(event.touches[0]?.clientY ?? null);
        if (direction !== null) {
          wantsEarlierRef.current = direction < 0;
          if (!wantsEarlierRef.current) continuationTopRef.current = null;
          if (wantsEarlierRef.current && !loadingEarlierRef.current) earlierAttemptRef.current = null;
        }
      }}
      onTouchEnd={() => { scrollActivityRef.current!.endTouch(); }}
      onTouchCancel={() => { scrollActivityRef.current!.endTouch(); }}
      onPointerDownCapture={() => { navigationAnchorRef.current = null; }}
      onKeyDownCapture={event => {
        navigationAnchorRef.current = null;
        if (['Home', 'PageUp', 'ArrowUp', 'End', 'PageDown', 'ArrowDown'].includes(event.key)) {
          if (!laterPendingRef.current) laterAttemptRef.current = null;
          loadLaterRef.current();
          wantsEarlierRef.current = ['Home', 'PageUp', 'ArrowUp'].includes(event.key);
          if (!wantsEarlierRef.current) continuationTopRef.current = null;
          if (wantsEarlierRef.current && !loadingEarlierRef.current) earlierAttemptRef.current = null;
          scrollActivityRef.current!.activity();
        }
      }}
      onLoadCapture={() => {
        if (navigationAnchorRef.current) { alignNavigationTarget(); return; }
        const stream = streamRef.current;
        if (stream && stickToBottomRef.current && !viewingHistory) stream.scrollTop = stream.scrollHeight;
        else restoreReadingPosition();
      }}
      onScroll={(event) => {
        if (!initialScrollReadyRef.current || navigatingRef.current) return;
        const stream = event.currentTarget;
        // Layout compensation emits scroll too; it must not replace the reader's anchor.
        const restored = restoredScrollTopRef.current;
        restoredScrollTopRef.current = null;
        // Safari's rubber-band return is not a change in the reader's direction.
        const delta = historyScrollDelta(previousScrollTopRef.current, stream.scrollTop,
          stream.scrollHeight - stream.clientHeight);
        previousScrollTopRef.current = stream.scrollTop;
        if (restored !== null && Math.abs(stream.scrollTop - restored) < 1) return;
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
        setAwayFromBottom(!stickToBottomRef.current);
        rememberReadingPosition();
        if (!navigationAnchorRef.current && stream.scrollTop < stream.clientHeight * 2) prefetchEarlier();
      }}
    >
      <div className="message-stream-inner" ref={innerRef}>
      {hasMoreHistory && (
        <div className="history-sentinel" data-history-sentinel aria-busy={loadingHistory}>
          {loadingHistory && <LoaderCircle size={15} className="spin" role="status" aria-label="正在加载更早记录" />}
        </div>
      )}
      {sections.map((section, index) => section.user
        ? <Fragment key={section.key}>
          <MessageItem item={(section.entries[0] as Extract<TimelineEntry, { type: 'message' }>).item}
            showFull={navigationContext || viewingHistory} />
          {section.turnId && turnTimings[section.turnId]?.error && !sections.some(other => !other.user && other.turnId === section.turnId) &&
            !sections.slice(index + 1).some(other => other.turnId === section.turnId) &&
            <NativeTurnError turn={turnTimings[section.turnId]} />}
        </Fragment>
        : <ResponseSection section={section} timing={section.showTiming && section.turnId ? turnTimings[section.turnId] : undefined}
            active={section.turnId === activeTurnId} onInteract={preserveActivityPosition} key={section.key}
            onFork={onFork} onError={onActionError} />
      )}
      {emptyError?.error && <NativeTurnError turn={emptyError} />}
      {!viewingHistory && activeTurnId && !sections.some((section) => !section.user && section.turnId === activeTurnId) && (
        <div className="turn-response"><div className="worked-divider">
          <TurnDuration timing={turnTimings[activeTurnId]} active />
        </div></div>
      )}
      {hasNewerHistory && <div ref={laterSentinelRef} className="history-sentinel" aria-busy={loadingLaterHistory}>
        {loadingLaterHistory && <LoaderCircle size={15} className="spin" role="status" aria-label="正在加载后续记录" />}
      </div>}
      </div>
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
          const stream = streamRef.current;
          if (stream) stream.scrollTop = stream.scrollHeight;
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
