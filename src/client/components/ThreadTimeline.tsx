import {
  BrainCircuit,
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FoldVertical,
  FileCode2,
  Globe2,
  Image,
  LoaderCircle,
  MessageSquareText,
  Play,
  TerminalSquare
} from 'lucide-react';
import { Copy, Check, MoreHorizontal, GitFork } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { HistoryThreadContext, useHistoryDetails } from '../history-details';
import { localImageSource } from '../markdown-media';
import { itemKey } from '../remote-state';
import type { ThreadItem } from '../types';
import { buildTimelineEntries, buildTimelineSections, isActivityIssue, type TimelineEntry, type TimelineSection } from '../timeline-model';
import { elapsedTurnMs, formatWorkDuration, type TurnTiming } from '../../shared/turn-timing';
import { hostNow } from '../host-clock';
import { userMessageText } from '../../shared/user-message';
import type { OutlineTurn } from '../../shared/thread-outline';
import { ThreadNavigation, type NavigationTarget } from './ThreadNavigation';
import { ImagePreview } from './ImagePreview';
import { markdownBlocks, remarkAssistantSources } from '../markdown-blocks';
import { copyText } from '../clipboard';
import { captureReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from '../reading-anchor';
import { PreviewImage, PreviewLink } from './PreviewLinks';
import { SubagentRows } from './Subagents';
import { isSubagentItem } from '../subagents';
import { HistoryScroll, historyScrollDelta, type BeforeHistoryCommit } from '../history-scroll';
import { isReadableHistoryItem } from '../history-prefetch';
import { NativeTurnError } from './NativeTurnError';

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

const INITIAL_ACTIVITY_ITEMS = 60;
const ACTIVITY_PAGE_ITEMS = 120;

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

const ResponseSection = memo(function ResponseSection({ section, timing, active, onInteract, onFork, onError }: {
  section: TimelineSection;
  timing: TurnTiming | undefined;
  active: boolean;
  onInteract: () => void;
  onFork: ((turnId: string) => Promise<void>) | undefined;
  onError: ((error: unknown) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  let finalIndex = -1;
  section.entries.forEach((entry, index) => {
    if (entry.type === 'message' && entry.item.type === 'agentMessage' &&
      entry.item.phase !== 'commentary' && entry.item.phase !== 'partial_answer' &&
      (!entry.item.questions?.length || entry.item.text.trim())) finalIndex = index;
  });
  const finalEntry = section.entries[finalIndex];
  const completed = !active && (timing ? timing.status !== 'inProgress'
    : finalEntry?.type === 'message' && finalEntry.item.completedAtMs != null);
  const finalStartedAtMs = finalEntry?.type === 'message' ? finalEntry.item.startedAtMs ?? null : null;
  const agentItems = useMemo(() => section.entries.flatMap(entry =>
    entry.type === 'event' && isSubagentItem(entry.item) ? [entry.item] : []), [section.entries]);
  const firstAgentKey = section.entries.find(entry => entry.type === 'event' && isSubagentItem(entry.item))?.key;
  const trace = (completed ? section.entries.slice(0, finalIndex < 0 ? undefined : finalIndex) : section.entries)
    .filter(entry => !completed || entry.type !== 'event' || !isSubagentItem(entry.item));
  const answer = completed && finalIndex >= 0 ? section.entries.slice(finalIndex)
    .filter(entry => entry.type !== 'event' || !isSubagentItem(entry.item)) : [];
  const renderEntry = (entry: TimelineEntry) => entry.type === 'activity'
    ? <ActivityGroup entry={entry} onInteract={onInteract} key={entry.key} />
    : entry.type === 'event' ? isSubagentItem(entry.item)
      ? entry.key === firstAgentKey ? <SubagentRows items={agentItems} key={entry.key} /> : null
      : <ActivityItem item={entry.item} running={false} key={entry.key} />
    : <MessageItem item={entry.item} key={entry.key} />;
  return <section className="turn-response" data-turn-id={section.turnId} data-scroll-anchor={`response-${section.key}`}>
    {(timing || active && section.showTiming) && <div className="worked-divider">
      {completed && trace.length > 0 ? <button type="button" className="turn-disclosure" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { onInteract(); setOpen(value => !value); }}>
        <TurnDuration timing={timing} active={false} finalStartedAtMs={finalStartedAtMs} />
        <ChevronRight size={13} className={open ? 'is-open' : ''} aria-hidden="true" />
      </button> : <TurnDuration timing={timing} active={active} finalStartedAtMs={finalStartedAtMs} />}
    </div>}
    {(!completed || open) && <div className="turn-activity" id={bodyId}>{trace.map(renderEntry)}</div>}
    {completed && agentItems.length > 0 && <SubagentRows items={agentItems} />}
    {answer.map(renderEntry)}
    <NativeTurnError turn={timing} />
    {!active && finalIndex >= 0 && <ReplyActions text={section.entries.slice(finalIndex).flatMap(entry =>
      entry.type === 'message' && entry.item.type === 'agentMessage' ? [entry.item.text] : []).join('\n\n')}
      turnId={section.turnId} onFork={onFork} onError={onError} />}
  </section>;
});

function ReplyActions({ text, turnId, onFork, onError }: {
  text: string; turnId: string | undefined;
  onFork: ((turnId: string) => Promise<void>) | undefined; onError: ((error: unknown) => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);
  return <div className="reply-actions">
    <button type="button" className="icon-button" aria-label={copied ? '已复制回复' : '复制回复'}
      title={copied ? '已复制' : '复制回复'} onClick={() => {
        void copyText(text).then(() => setCopied(true)).catch(onError);
      }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    {onFork && turnId && <button type="button" className="icon-button" aria-label="回复操作" title="回复操作"
      disabled={busy} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ left: Math.max(8, Math.min(rect.left, innerWidth - 220)), top: Math.max(8, rect.top - 48) });
      }}><MoreHorizontal size={17} /></button>}
    {menu && createPortal(<>
      <button type="button" className="queue-menu-backdrop" aria-label="关闭回复菜单" onClick={() => setMenu(null)} />
      <div className="queue-menu" role="menu" style={menu}>
        <button type="button" role="menuitem" onClick={() => {
          setMenu(null); setBusy(true);
          void onFork!(turnId!).catch(onError).finally(() => setBusy(false));
        }}><GitFork size={15} />分支到新聊天</button>
      </div>
    </>, document.body)}
  </div>;
}

function TurnDuration({ timing, active, finalStartedAtMs }: {
  timing: TurnTiming | undefined; active: boolean; finalStartedAtMs?: number | null;
}) {
  const [now, setNow] = useState(hostNow);
  useEffect(() => {
    if (!active || timing?.startedAt == null || finalStartedAtMs != null) return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearInterval(timer);
      setNow(hostNow());
      timer = document.visibilityState === 'hidden' ? undefined
        : window.setInterval(() => setNow(hostNow()), 1000);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [active, timing?.startedAt, finalStartedAtMs]);
  const duration = timing ? elapsedTurnMs(active ? { ...timing, status: 'inProgress' } : timing, now, finalStartedAtMs) : null;
  const working = active && finalStartedAtMs == null;
  const text = duration === null ? (working ? '处理中' : '活动')
    : !active && timing?.status === 'interrupted' ? `你在 ${formatWorkDuration(duration)} 后停止了`
    : working && duration < 1000 ? '处理中' : `${working ? '已处理' : '用时'} ${formatWorkDuration(duration)}`;
  return <span className="turn-duration">{text}</span>;
}

const MessageItem = memo(function MessageItem({ item, showFull = false }: { item: ThreadItem; showFull?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (item.type === 'userMessage') {
    const text = (item.content ?? []).filter((entry) => entry.type === 'text')
      .map((entry) => userMessageText(entry.text ?? '')).filter(Boolean).join('\n\n');
    const images = (item.content ?? []).filter((entry) => entry.type === 'image' || entry.type === 'localImage');
    const long = text.length > 900 && !showFull;
    return (
      <article className="message message--user" data-user-key={itemKey(item)} data-turn-id={item.turnId}
        data-scroll-anchor={itemKey(item)}>
        <div className="user-message-body">
          {images.length > 0 && <div className="user-message-attachments" aria-label={`${images.length} 个图片附件`}>
            {images.map((entry, index) => (
              <ImagePreview key={index} src={localImageSource(entry.path ?? entry.url)} alt={`图片附件 ${index + 1}`} />
            ))}
          </div>}
          {text && <div className="user-message-text">{long && !expanded ? `${text.slice(0, 800)}...` : text}</div>}
          {long && (
            <button type="button" className="message-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起消息' : '展开消息'}
            </button>
          )}
        </div>
      </article>
    );
  }

  if (item.type === 'agentMessage') {
    return (
      <article className={`message message--agent${item.phase === 'commentary' ? ' message--commentary' : ''}`}
        data-scroll-anchor={itemKey(item)}>
        <div className="agent-message-body markdown">
          <MarkdownText text={item.text} assistant />
        </div>
      </article>
    );
  }

  return null;
});

const ActivityGroup = memo(function ActivityGroup({
  entry,
  onInteract
}: {
  entry: Extract<TimelineEntry, { type: 'activity' }>;
  onInteract: () => void;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'issues'>('all');
  const [visibleCount, setVisibleCount] = useState(INITIAL_ACTIVITY_ITEMS);
  const issueCount = entry.failedCount + entry.declinedCount;
  const { label, Icon } = activityPresentation(entry);
  const filteredItems = useMemo(
    () => filter === 'issues' ? entry.items.filter(isActivityIssue) : entry.items,
    [entry.items, filter]
  );
  const hiddenCount = Math.max(0, filteredItems.length - visibleCount);
  const visibleItems = hiddenCount > 0 ? filteredItems.slice(-visibleCount) : filteredItems;
  const issueLabel = [
    entry.failedCount > 0 ? `${entry.failedCount} 条失败` : '',
    entry.declinedCount > 0 ? `${entry.declinedCount} 条已拒绝` : ''
  ].filter(Boolean).join('，');
  const selectFilter = (value: 'all' | 'issues') => {
    setFilter(value);
    setVisibleCount(INITIAL_ACTIVITY_ITEMS);
  };

  return (
    <section className={`activity-group${open ? ' activity-group--open' : ''}`} onClick={onInteract}>
      <div className="activity-group-header">
        <button
          type="button"
          className="activity-group-toggle"
          data-scroll-anchor={entry.key}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          {entry.running
            ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
            : <Icon size={15} aria-hidden="true" />}
          <span className="activity-group-label">{label}</span>
          <ChevronDown size={13} className="summary-chevron" aria-hidden="true" />
        </button>
        {open && issueCount > 0 && (
          <button
            type="button"
            className="activity-group-issues"
            title={issueLabel}
            aria-label={`查看异常记录：${issueLabel}`}
            aria-controls={bodyId}
            onClick={() => { selectFilter('issues'); setOpen(true); }}
          >
            <CircleAlert size={13} aria-hidden="true" />
            <span>{issueCount} 项异常</span>
          </button>
        )}
      </div>
      {open && (
        <div className="activity-group-body" id={bodyId}>
          {issueCount > 0 && (
            <div className="activity-filters" role="group" aria-label="筛选执行记录">
              <button type="button" aria-pressed={filter === 'all'} onClick={() => selectFilter('all')}>
                全部 <span>{entry.items.length}</span>
              </button>
              <button type="button" aria-pressed={filter === 'issues'} title={issueLabel} onClick={() => selectFilter('issues')}>
                异常 <span>{issueCount}</span>
              </button>
            </div>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="activity-group-more"
              onClick={() => setVisibleCount((current) => current + ACTIVITY_PAGE_ITEMS)}
            >
              显示更早的记录（{hiddenCount}）
            </button>
          )}
          {visibleItems.map((item) => (
            <ActivityItem item={item} running={entry.running} key={itemKey(item)} />
          ))}
        </div>
      )}
    </section>
  );
}, (previous, next) =>
  previous.entry.running === next.entry.running &&
  previous.entry.failedCount === next.entry.failedCount &&
  previous.entry.declinedCount === next.entry.declinedCount &&
  previous.onInteract === next.onInteract &&
  previous.entry.items.length === next.entry.items.length &&
  previous.entry.items.every((item, index) => item === next.entry.items[index])
);

function activityPresentation(entry: Extract<TimelineEntry, { type: 'activity' }>) {
  const presentations = {
    tool: { Icon: TerminalSquare, label: '调用了工具', running: '正在调用工具' },
    file: { Icon: FileCode2, label: '编辑了文件', running: '正在编辑文件' },
    command: { Icon: TerminalSquare, label: '运行了命令', running: '正在运行命令' },
    search: { Icon: Globe2, label: '已搜索网页', running: '正在搜索网页' },
    image: { Icon: Image, label: `已查看 ${entry.items.length} 张图像`, running: '正在查看图片' },
    reasoning: { Icon: BrainCircuit, label: '思考过程', running: '正在思考' }
  };
  const presentation = presentations[entry.kind];
  const latest = [...entry.items].reverse().find(item => 'status' in item && item.status === 'inProgress');
  const activeKind = latest?.type === 'fileChange' ? 'file' : latest?.type === 'webSearch' ? 'search'
    : latest?.type === 'commandExecution' ? 'command' : latest ? entry.kind : 'reasoning';
  return { Icon: presentation.Icon, label: entry.running ? presentations[activeKind].running
    : (['tool', 'file', 'command', 'search', 'image'] as const).filter(kind => entry.kinds.includes(kind))
      .map(kind => presentations[kind].label).join('、') };
}

const ActivityItem = memo(function ActivityItem({ item: summary, running }: { item: ThreadItem; running: boolean }) {
  const [open, setOpen] = useState(false);
  const { item, loading, error, retry } = useHistoryDetails(summary, open);
  const detailNotice = loading ? <p role="status">正在加载执行详情…</p> : error
    ? <p role="alert">{error} <button type="button" className="text-button" onClick={retry}>重试</button></p> : null;
  const status = 'status' in item
    ? item.status === 'inProgress' && !running ? 'ended' : item.status
    : undefined;
  const anchorProps = { 'data-scroll-anchor': itemKey(item) };
  const detailProps = { ...anchorProps,
    onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open) };
  if (item.type === 'agentMessage') {
    return <div className="activity-commentary markdown" {...anchorProps}><MarkdownText text={item.text} assistant /></div>;
  }
  if (item.type === 'reasoning') {
    return (
      <details className="activity-row activity-row--reasoning" {...detailProps}>
        <summary>
          <BrainCircuit size={15} aria-hidden="true" />
          <span>推理过程</span>
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body reasoning-body">
          {[...item.summary, ...item.content].map((part, index) => (
            <p key={index}>{part}</p>
          ))}
        </div>}
      </details>
    );
  }

  if (item.type === 'commandExecution') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          {status === 'inProgress' ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : status === 'failed' ? (
            <CircleAlert size={15} aria-hidden="true" />
          ) : (
            <TerminalSquare size={15} aria-hidden="true" />
          )}
          <span className="activity-command-preview" title={item.command}>{item.command.trim().replace(/\s+/g, ' ') || '命令执行'}</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body">
          {detailNotice}
          <pre className="command-block">{item.command}</pre>
          {item.aggregatedOutput && <pre className="output-block">{item.aggregatedOutput}</pre>}
          {(item.exitCode !== null || item.durationMs !== null) && (
            <div className="activity-meta">
              {item.exitCode !== null && <span>Exit {item.exitCode}</span>}
              {item.durationMs !== null && <span>{formatDuration(item.durationMs)}</span>}
            </div>
          )}
        </div>}
      </details>
    );
  }

  if (item.type === 'fileChange') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          {item.status === 'completed' ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <FileCode2 size={15} aria-hidden="true" />
          )}
          <span>文件变更</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body file-list">
          {detailNotice}
          {item.changes?.map((change, index) => (
            <div className="file-change" key={`${change.path}-${index}`}>
              <code>{change.path}</code>
              {change.diff && <pre className="output-block">{change.diff}</pre>}
            </div>
          ))}
        </div>}
      </details>
    );
  }

  if (item.type === 'plan') {
    return (
      <div className="plan-row" {...anchorProps}>
        <Play size={15} aria-hidden="true" />
        <div>
          <strong>执行计划</strong>
          <p>{item.text}</p>
        </div>
      </div>
    );
  }

  if (item.type === 'mcpToolCall') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          <TerminalSquare size={15} aria-hidden="true" />
          <span>{item.server}/{item.tool}</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body">
          {detailNotice ?? <pre className="output-block">{JSON.stringify(item.result ?? item.error ?? item.arguments, null, 2)}</pre>}
        </div>}
      </details>
    );
  }

  if (item.type === 'dynamicToolCall') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          <TerminalSquare size={15} aria-hidden="true" />
          <span>{item.tool}</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body">
          {detailNotice ?? <pre className="output-block">{JSON.stringify(item.contentItems ?? item.arguments, null, 2)}</pre>}
        </div>}
      </details>
    );
  }

  if (item.type === 'webSearch') {
    return (
      <div className="activity-row activity-row--static" {...anchorProps}>
        <Globe2 size={15} aria-hidden="true" />
        <span>网页搜索</span>
        {item.query && <code>{item.query}</code>}
      </div>
    );
  }

  if (item.type === 'imageView') {
    return (
      <figure className="activity-image" {...anchorProps}>
        <ImagePreview src={localImageSource(item.path)} />
      </figure>
    );
  }

  if (item.type === 'imageGeneration') {
    return (
      <div className="activity-row activity-row--static" {...anchorProps}>
        <Image size={15} aria-hidden="true" />
        <span>图片生成</span>
      </div>
    );
  }

  if (item.type === 'contextCompaction') {
    return (
      <div className="context-divider" {...anchorProps}>
        <FoldVertical size={15} aria-hidden="true" />
        <span>上下文已自动压缩</span>
      </div>
    );
  }

  return null;
});

export const MarkdownText = memo(function MarkdownText({ text, assistant = false }: { text: string; assistant?: boolean }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return <>{blocks.map(block => <MarkdownBlock key={block.offset} text={block.text} assistant={assistant} />)}</>;
});

const MarkdownBlock = memo(function MarkdownBlock({ text, assistant }: { text: string; assistant: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={assistant ? [remarkGfm, remarkAssistantSources] : [remarkGfm]}
      urlTransform={(url) =>
        /^(?:file:\/\/|[a-z]:[\\/])/i.test(url) || localImageSource(url).startsWith('/api/local-image?') ? url : defaultUrlTransform(url)
      }
      components={{
        a: PreviewLink,
        img: ({ src, alt }) => (
          <PreviewImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />
        )
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') return null;
  return <span className={`status-badge status-badge--${status}`}>{statusLabel(status)}</span>;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'inProgress':
      return '运行中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'declined':
      return '已拒绝';
    case 'ended':
      return '已结束';
    default:
      return status;
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}
