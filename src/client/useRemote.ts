import { historyConfig } from './history-config';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';

import type { ClientRpcMethod, ServerMessage } from '../shared/protocol';
import type { TurnTiming } from '../shared/turn-timing';
import type { OutlineTurn } from '../shared/thread-outline';
import { permissionProfileId, permissionProfileUpdate, type PermissionProfile, type PermissionSettings } from '../shared/permissions';
import { api, HttpError, isAbortedRequest, ReadRequests } from './api';
import { beginForegroundRead, constrainedNetwork, prioritizeInteraction, yieldToInteraction } from './background-work';
import { readDeviceWorkspace, saveDeviceWorkspace, readDeviceChat, saveDeviceChat, removeDeviceChat } from './device-snapshots';
import { applyTaskPage, provisionalHistory, provisionalThread, type OpenThreadPage, type ThreadListPage } from './loading-snapshots';
import { RemoteConnection, type RemoteChannel } from './remote-connection';
import { itemKey, mergeEmbeddedTurnItems, mergeLatestHistoryItems, mergeOlderHistoryItems, mergeOlderTurnTimings, mergeTurnTimings, reconcileThreadList, upsertItem } from './remote-state';
import type {
  BridgeStatus,
  ModelInfo,
  ProjectInfo,
  ServerRequest,
  Thread,
  ThreadGoal,
  ThreadHistoryPage,
  ThreadItem,
  Turn
} from './types';
import type { WorkspaceBootstrap } from './types';
import type { CollaborationMode, ComposerAttachment, ContextUsage, McpStatus, ReviewTarget, SkillInfo, SkillsResult } from './types';
import { turnInput } from './slash-commands';
import { dedupeThreads } from './workspace-model';
import { loadedOutline, mergeOutlineTurns } from './thread-navigation';
import type { ChatEventListener, ChatTransport } from './chat-transport';
import { isTaskThread } from '../shared/thread-source';
import { HistoryPrefetch, prepareHistoryPage } from './history-prefetch';
import type { BeforeHistoryCommit } from './history-scroll';
import { markStartup } from './startup';
import { parseThreadGoal, goalUpdateParams, type GoalUpdate } from './goal';

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

interface PendingServerResponse {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
}

interface UseRemoteOptions {
  authenticated: boolean;
  onAuthExpired?: () => void;
  bootstrap: WorkspaceBootstrap | null;
  bootstrapRequest?: Promise<WorkspaceBootstrap | null> | undefined;
}

export interface ThreadSettingsPatch {
  model?: string;
  effort?: string;
  permissions?: string;
  collaborationMode?: CollaborationMode;
}

export interface CreateThreadOptions {
  cwd?: string;
  projectId?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  collaborationMode?: CollaborationMode;
}

export function useRemote({ authenticated, onAuthExpired, bootstrap, bootstrapRequest }: UseRemoteOptions) {
  const [connected, setConnected] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ status: 'offline' });
  const [threads, setThreads] = useState<Thread[]>(() => dedupeThreads((bootstrap?.threads?.data ?? []).filter(isTaskThread)));
  const [threadsLoading, setThreadsLoading] = useState(!bootstrap?.threads);
  const [models, setModels] = useState<ModelInfo[]>(bootstrap?.models?.data ?? []);
  const [permissionProfiles, setPermissionProfiles] = useState<PermissionProfile[]>([]);
  const [defaultPermissionProfile, setDefaultPermissionProfile] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>(bootstrap?.projects?.data ?? []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [activeGoal, setActiveGoal] = useState<ThreadGoal | null>(null);
  const goalRevisionRef = useRef(0);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [turnTimings, setTurnTimings] = useState<Record<string, TurnTiming>>({});
  const [tokenUsage, setTokenUsage] = useState<Record<string, ContextUsage>>({});
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasNewerHistory, setHasNewerHistory] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [loadingLaterHistory, setLoadingLaterHistory] = useState(false);
  const [revealingHistory, setRevealingHistory] = useState(false);
  const [outlineTurns, setOutlineTurns] = useState<OutlineTurn[]>([]);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [questionCounts, setQuestionCounts] = useState<Record<string, number>>({});
  const [serverRequests, setServerRequests] = useState<ServerRequest[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadReady, setThreadReady] = useState(false);
  const [verifiedThreadId, setVerifiedThreadId] = useState<string | null>(null);
  const [timedThreadId, setTimedThreadId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const socketRef = useRef<RemoteChannel | null>(null);
  const pendingRef = useRef(new Map<string, PendingRpc>());
  const pendingServerResponsesRef = useRef(new Map<string, PendingServerResponse>());
  const refreshThreadsTimerRef = useRef<number | null>(null);
  const activeThreadRef = useRef<string | null>(null);
  const threadsRef = useRef(threads);
  const activeTurnIdRef = useRef<string | null>(null);
  const turnRevisionRef = useRef(0);
  const itemsRef = useRef(items);
  const olderHistoryCursorRef = useRef<string | null>(null);
  const newerHistoryCursorRef = useRef<string | null>(null);
  const viewingHistoryRef = useRef(false);
  const pendingRevealRef = useRef<{ version: number; wasViewing: boolean } | null>(null);
  const turnsCursorRef = useRef<string | null>(null);
  const turnTimingsRef = useRef(turnTimings);
  const selectionVersionRef = useRef(0);
  const historyRefreshRef = useRef<Promise<void> | null>(null);
  const listRefreshRef = useRef<Promise<Thread[]> | null>(null);
  const listPaginationRef = useRef<AbortController | null>(null);
  const listRetryTimerRef = useRef<number | undefined>(undefined);
  const listFailuresRef = useRef(0);
  const listStartedAtRef = useRef(0);
  const listFirstPagePendingRef = useRef(false);
  const listErrorRef = useRef<string | null>(null);
  const retryThreadsRef = useRef<() => void>(() => {});
  const connectionRef = useRef<RemoteConnection | null>(null);
  const archivedRef = useRef(false);
  const newThreadsRef = useRef(new Set<string>());
  const permissionRequestVersionRef = useRef(0);
  const loadingHistoryRef = useRef(false);
  const streamFlushTimerRef = useRef<number | null>(null);
  const agentDeltasRef = useRef(new Map<string, string>());
  const commandDeltasRef = useRef(new Map<string, string>());
  const disposedRef = useRef(false);
  const authExpiredRef = useRef(onAuthExpired);
  const initializedRef = useRef(false);
  const historyCacheRef = useRef(new Map<string, ThreadHistoryPage>());
  const navigationRevisionRef = useRef(0);
  const navigationCacheRef = useRef(new Map<string, { threadId: string; turnId: string; savedAt: number;
    page: Pick<ThreadHistoryPage, 'items' | 'nextCursor'> & { newerCursor: string | null } }>());
  const nativeListSeenRef = useRef(false);
  const nativeProjectsSeenRef = useRef(false);
  const nativeModelsSeenRef = useRef(false);
  const metadataVersionsRef = useRef({ models: 0, projects: 0 });
  const metadataFailuresRef = useRef(new Set<'models' | 'projects'>());
  const metadataErrorsRef = useRef<Partial<Record<'models' | 'projects', string>>>({});
  const retryMetadataRef = useRef<() => void>(() => {});
  const provisionalListRef = useRef(new Map<string, Thread>());
  const verifiedThreadRef = useRef<string | null>(null);
  const timedThreadRef = useRef<string | null>(null);
  const timingErrorRef = useRef<string | null>(null);
  const lastRecoveryRef = useRef(0);
  const additionalThreadsRef = useRef<string[]>([]);
  const threadWatchersRef = useRef(new Map<string, string[]>());
  const eventListenersRef = useRef(new Set<ChatEventListener>());
  const dirtyThreadIdsRef = useRef(new Set<string>());
  const replayCursorRef = useRef<{ epoch: string; sequence: number } | null>(bootstrap?.cursor ?? null);
  const outlineRefreshRef = useRef<(() => void) | null>(null);
  const historyRequestsRef = useRef(new ReadRequests());
  const permissionRequestsRef = useRef(new ReadRequests());
  const listRequestsRef = useRef(new ReadRequests());
  const metadataRequestsRef = useRef(new ReadRequests());
  const earlierPageRef = useRef(new HistoryPrefetch());

  activeThreadRef.current = activeThreadId;
  threadsRef.current = threads;
  itemsRef.current = items;
  turnTimingsRef.current = turnTimings;
  activeTurnIdRef.current = activeTurnId;
  verifiedThreadRef.current = verifiedThreadId;
  timedThreadRef.current = timedThreadId;
  authExpiredRef.current = onAuthExpired;

  const rpc = useCallback(<T,>(method: ClientRpcMethod, params: unknown = {}): Promise<T> => {
    if (/^(turn\/|thread\/queue\/|review\/)/.test(method)) prioritizeInteraction();
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Remote connection is not ready.'));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!pendingRef.current.has(id)) return;
        pendingRef.current.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, 120_000);
      pendingRef.current.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ type: 'rpc', id, method, params }));
    });
  }, []);

  const watchThread = useCallback((threadId: string | null) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'thread.watch', threadId,
        additionalThreadIds: additionalThreadsRef.current }));
    }
  }, []);

  const chatTransport = useMemo<ChatTransport>(() => ({
    rpc,
    subscribe(listener) {
      eventListenersRef.current.add(listener);
      return () => { eventListenersRef.current.delete(listener); };
    },
    watch(threadIds, owner) {
      if (threadIds.length) threadWatchersRef.current.set(owner, threadIds);
      else threadWatchersRef.current.delete(owner);
      additionalThreadsRef.current = [...new Set([...threadWatchersRef.current.values()].flat())];
      watchThread(activeThreadRef.current);
    }
  }), [rpc, watchThread]);

  const refreshThreads = useCallback((firstPage?: NonNullable<WorkspaceBootstrap['threads']>): Promise<Thread[]> => {
    if (listRefreshRef.current) return listRefreshRef.current;
    window.clearTimeout(listRetryTimerRef.current);
    const archived = archivedRef.current;
    const controller = new AbortController();
    listPaginationRef.current = controller;
    listStartedAtRef.current = Date.now();
    listFirstPagePendingRef.current = true;
    const baseline = [...threadsRef.current];
    const knownIds = new Set(baseline.map(thread => thread.id));
    const request = (async () => {
    setThreadsLoading(true);
    try {
      const collected: Thread[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const query = new URLSearchParams({ archived: String(archived) });
        if (cursor) query.set('cursor', cursor);
        let result: ThreadListPage = firstPage && cursor === null ? firstPage
          : await listRequestsRef.current.get(`/api/threads?${query}`,
            cursor === null && listFailuresRef.current === 0 ? 4000 : 15000);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (result.snapshot?.stale) {
          if (archived === archivedRef.current) {
            const preview = result.data.filter(isTaskThread).map(provisionalThread);
            setThreads(current => {
              const additions = preview.filter(thread => !current.some(entry => entry.id === thread.id));
              additions.forEach(thread => provisionalListRef.current.set(thread.id, thread));
              return dedupeThreads([...additions, ...current]);
            });
            markStartup('tasks-snapshot');
          }
          query.set('fresh', '1');
          result = await listRequestsRef.current.get(`/api/threads?${query}`);
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        listFirstPagePendingRef.current = false;
        nativeListSeenRef.current = true;
        const priorListError = listErrorRef.current;
        setLastError(current => current === priorListError ? null : current);
        listErrorRef.current = null;
        const page = (result.data ?? []).filter(isTaskThread).map((thread) => ({ ...thread, archived }));
        collected.push(...page);
        for (const thread of provisionalListRef.current.values()) {
          if (!knownIds.has(thread.id)) { knownIds.add(thread.id); baseline.push(thread); }
        }
        const additions = page.filter(thread => !knownIds.has(thread.id));
        for (const thread of additions) {
          knownIds.add(thread.id);
          baseline.push(thread);
        }
        if (archived === archivedRef.current) {
          if (cursor === null) markStartup('tasks');
          setThreads((current) => {
            // Existing rows reconcile once at the end, preserving live changes between pages.
            const partial = dedupeThreads([...additions, ...applyTaskPage(current, page, provisionalListRef.current)]);
            return current.length === partial.length && partial.every((thread, index) => thread === current[index]) ? current : partial;
          });
        }
        if (archived !== archivedRef.current || !result.nextCursor || seenCursors.has(result.nextCursor)) break;
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
        await yieldToInteraction(controller.signal);
      }
      const nextThreads = dedupeThreads(collected);
      if (archived === archivedRef.current) {
        setThreads(current => reconcileThreadList(current, nextThreads, baseline));
      }
      listFailuresRef.current = 0;
      return nextThreads;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) authExpiredRef.current?.();
      else if (!controller.signal.aborted && !disposedRef.current && !isAbortedRequest(error)) {
        const message = error instanceof Error ? error.message : String(error);
        listErrorRef.current = message;
        setLastError(message);
        const delay = Math.min(500 * 2 ** Math.min(listFailuresRef.current++, 4), 5000);
        listRetryTimerRef.current = window.setTimeout(() => {
          if (!disposedRef.current && navigator.onLine) retryThreadsRef.current();
        }, delay);
      }
      throw error;
    } finally {
      if (listPaginationRef.current === controller) {
        listFirstPagePendingRef.current = false;
        setThreadsLoading(false);
      }
    }
    })().finally(() => {
      if (listRefreshRef.current === request) listRefreshRef.current = null;
    });
    listRefreshRef.current = request;
    return request;
  }, []);
  retryThreadsRef.current = () => { void refreshThreads().catch(() => undefined); };

  const restartTaskRead = useCallback(() => {
    listPaginationRef.current?.abort();
    listRequestsRef.current.cancel();
    listRefreshRef.current = null;
    retryThreadsRef.current();
  }, []);

  const reconnect = useCallback(() => {
    if (!authenticated) return;
    setLastError(null);
    restartTaskRead();
    retryMetadataRef.current();
    historyRequestsRef.current.cancel();
    connectionRef.current?.reconnect();
  }, [authenticated, restartTaskRead]);

  const refreshMetadata = useCallback(async (kind: 'models' | 'projects') => {
    const version = ++metadataVersionsRef.current[kind];
    try {
      const result = await metadataRequestsRef.current.get<{ data: ModelInfo[] | ProjectInfo[] }>(
        `/api/metadata?kind=${kind}`, 10000, 3);
      if (disposedRef.current || metadataVersionsRef.current[kind] !== version) return;
      metadataFailuresRef.current.delete(kind);
      const previousError = metadataErrorsRef.current[kind];
      delete metadataErrorsRef.current[kind];
      if (previousError) setLastError(current => current === previousError
        ? metadataErrorsRef.current.models ?? metadataErrorsRef.current.projects ?? null : current);
      if (kind === 'models') {
        nativeModelsSeenRef.current = true;
        setModels((result.data ?? []) as ModelInfo[]);
      } else {
        nativeProjectsSeenRef.current = true;
        setProjects((result.data ?? []) as ProjectInfo[]);
      }
    } catch (error) {
      if (disposedRef.current || metadataVersionsRef.current[kind] !== version || isAbortedRequest(error)) return;
      if (error instanceof HttpError && error.status === 401) authExpiredRef.current?.();
      else {
        metadataFailuresRef.current.add(kind);
        const message = error instanceof Error ? error.message : String(error);
        metadataErrorsRef.current[kind] = message;
        setLastError(message);
      }
      throw error;
    }
  }, []);

  const refreshProjects = useCallback(() => refreshMetadata('projects'), [refreshMetadata]);

  const fetchHistoryPage = useCallback(async (threadId: string, before: string | null = null, direction: 'before' | 'after' = 'before') => {
    const query = new URLSearchParams({ threadId, limit: before === null ? '40' : '100' });
    if (before !== null) query.set(direction, before);
    if (before !== null && direction === 'before') query.set('conversation', '1');
    return historyRequestsRef.current.get<ThreadHistoryPage>(`/api/thread/history?${query.toString()}`);
  }, []);

  const refreshPermissions = useCallback(async (cwd?: string) => {
    const version = ++permissionRequestVersionRef.current;
    const query = new URLSearchParams(cwd ? { cwd } : {});
    const path = `/api/permissions?${query}`;
    if (!permissionRequestsRef.current.has(path)) permissionRequestsRef.current.cancel();
    try {
      const result = await permissionRequestsRef.current.get<{ data: PermissionProfile[]; defaultProfile: string | null }>(path);
      if (version !== permissionRequestVersionRef.current) return;
      setPermissionProfiles(result.data);
      setDefaultPermissionProfile(result.defaultProfile);
    } catch (error) {
      if (!isAbortedRequest(error)) throw error;
    }
  }, []);

  const clearStreamingDeltas = useCallback(() => {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    agentDeltasRef.current.clear();
    commandDeltasRef.current.clear();
  }, []);

  const flushStreamingDeltas = useCallback(() => {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    const agentDeltas = new Map(agentDeltasRef.current);
    const commandDeltas = new Map(commandDeltasRef.current);
    agentDeltasRef.current.clear();
    commandDeltasRef.current.clear();
    if (agentDeltas.size === 0 && commandDeltas.size === 0) return;

    setItems((current) => {
      let next = current;
      for (const [key, delta] of agentDeltas) {
        const [turnId, itemId] = JSON.parse(key) as [string, string];
        if (viewingHistoryRef.current && !next.some(item => itemKey(item) === key)) continue;
        next = upsertItem(
          next,
          {
            type: 'agentMessage',
            id: itemId,
            turnId,
            text: delta
          } as ThreadItem,
          true
        );
      }
      if (commandDeltas.size > 0) {
        next = next.map((item) =>
          item.type === 'commandExecution' && commandDeltas.has(itemKey(item))
            ? {
                ...item,
                aggregatedOutput: `${item.aggregatedOutput ?? ''}${commandDeltas.get(itemKey(item)) ?? ''}`
              }
            : item
        );
      }
      return next;
    });
  }, []);

  const queueStreamingDelta = useCallback(
    (kind: 'agent' | 'command', itemId: string, delta: string, turnId: string) => {
      const target = kind === 'agent' ? agentDeltasRef.current : commandDeltasRef.current;
      const key = itemKey({ id: itemId, turnId });
      target.set(key, `${target.get(key) ?? ''}${delta}`);
      if (streamFlushTimerRef.current !== null) return;
      streamFlushTimerRef.current = window.setTimeout(() => {
        streamFlushTimerRef.current = null;
        flushStreamingDeltas();
      }, document.visibilityState === 'hidden' ? 250 : constrainedNetwork() ? 100 : 60);
    },
    [flushStreamingDeltas]
  );

  const openThread = useCallback(
    async (
      threadId: string,
      options: { silent?: boolean; preserveHistory?: boolean } = {}
    ) => {
      if (options.silent && activeThreadRef.current !== threadId) return;
      if (options.silent && viewingHistoryRef.current) return;
      const isNew = newThreadsRef.current.has(threadId);
      const archived = threadsRef.current.find((thread) => thread.id === threadId)?.archived;
      const query = new URLSearchParams({
        threadId, mode: isNew ? 'new' : archived ? 'read' : 'resume'
      });
      const path = `/api/thread/open?${query}`;
      const cachedPage = historyCacheRef.current.get(threadId);
      const cached = cachedPage ? provisionalHistory(cachedPage) : undefined;
      const cachedItems = cached ? cached.items.map((entry) => ({
        ...entry.item, turnId: entry.turnId,
        startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs
      })) : [];
      const sameThread = activeThreadRef.current === threadId;
      if (!options.silent) {
        prioritizeInteraction();
        earlierPageRef.current.clear();
        selectionVersionRef.current += 1;
        if (!historyRequestsRef.current.has(path)) historyRequestsRef.current.cancel();
        pendingRevealRef.current = null;
        viewingHistoryRef.current = false;
        newerHistoryCursorRef.current = null;
        setViewingHistory(false);
        setHasNewerHistory(false);
        setLoadingLaterHistory(false);
        setRevealingHistory(false);
        if (activeThreadRef.current !== threadId) setOutlineTurns([]);
        activeThreadRef.current = threadId;
        watchThread(threadId);
        setActiveThreadId(threadId);
        const listed = threadsRef.current.find((thread) => thread.id === threadId);
        setActiveThread(listed ? provisionalThread(listed) : null);
        setThreadReady(false);
        setVerifiedThreadId(null);
        verifiedThreadRef.current = null;
        setTimedThreadId(null);
        timedThreadRef.current = null;
        timingErrorRef.current = null;
        setItems(cachedItems);
        const timings = { ...(sameThread ? turnTimingsRef.current : {}),
          ...Object.fromEntries((cached?.turns ?? []).map((turn) => [turn.id, turn])) };
        turnTimingsRef.current = timings;
        setTurnTimings(timings);
        turnsCursorRef.current = cached?.turnsCursor ?? null;
        olderHistoryCursorRef.current = null;
        setHasMoreHistory(false);
        setActiveTurnId(null);
        activeTurnIdRef.current = null;
        if (!sameThread) { goalRevisionRef.current++; setActiveGoal(null); }
      }
      const version = selectionVersionRef.current;
      let baseline = options.silent ? itemsRef.current : cachedItems;
      const timingBaseline = turnTimingsRef.current;
      const turnRevision = turnRevisionRef.current;
      let nativeArrived = false;
      let nativeTimingArrived = false;
      const currentSelection = () => version === selectionVersionRef.current && activeThreadRef.current === threadId;
      const preview = (thread: Thread, page: ThreadHistoryPage) => {
        if (!currentSelection() || options.silent || nativeArrived) return;
        const display = provisionalHistory(page);
        const previousBaseline = new Map(baseline.map(item => [itemKey(item), item]));
        baseline = display.items.map(entry => ({ ...entry.item, turnId: entry.turnId,
          startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs }));
        setActiveThread(provisionalThread(thread));
        const projected = baseline;
        setItems(current => mergeLatestHistoryItems(projected,
          current.filter(item => previousBaseline.get(itemKey(item)) !== item)));
        if (!nativeTimingArrived && timedThreadRef.current !== threadId) {
          setTurnTimings(Object.fromEntries(display.turns.map(turn => [turn.id, turn])));
        }
        setLoadingThread(false);
        markStartup('chat-snapshot');
      };
      if (options.silent) flushStreamingDeltas();
      else clearStreamingDeltas();
      if (!options.silent) {
        loadingHistoryRef.current = false;
        setLoadingHistory(false);
      }
      if (!options.silent) {
        setLoadingThread(cachedItems.length === 0);
        void readDeviceChat(threadId).then(saved => {
          if (saved && !cached) preview(saved.thread, saved.page);
        });
      }
      setLastError(null);
      const endForeground = options.silent ? () => {} : beginForegroundRead();
      type TimingPage = Pick<ThreadHistoryPage, 'turns' | 'turnsCursor' | 'activeTurnId'> & {
        snapshot?: { stale: boolean; savedAt: number }
      };
      const timingPath = `/api/thread/timings?${new URLSearchParams({ threadId })}`;
      const timings: Promise<TimingPage> = isNew ? Promise.resolve({
        turns: [], turnsCursor: null, activeTurnId: null
      }) : historyRequestsRef.current.get<TimingPage>(timingPath, historyConfig.readTimeoutMs, 3).then(page =>
        page.snapshot?.stale ? historyRequestsRef.current.get<TimingPage>(`${timingPath}&fresh=1`, historyConfig.readTimeoutMs, 3) : page);
      void timings.then(page => {
        if (!currentSelection()) return;
        const firstTimingPage = timedThreadRef.current !== threadId;
        nativeTimingArrived = true;
        setTurnTimings(current => {
          const next = mergeTurnTimings(current, page.turns, timingBaseline);
          turnTimingsRef.current = next;
          return next;
        });
        if (turnRevisionRef.current === turnRevision && (firstTimingPage || options.silent)) {
          activeTurnIdRef.current = page.activeTurnId;
          setActiveTurnId(page.activeTurnId);
        }
        if (firstTimingPage) turnsCursorRef.current = page.turnsCursor;
        timedThreadRef.current = threadId;
        setTimedThreadId(threadId);
        const previousError = timingErrorRef.current;
        timingErrorRef.current = null;
        if (previousError) setLastError(current => current === previousError ? null : current);
      }).catch(error => {
        if (error instanceof HttpError && error.status === 401) authExpiredRef.current?.();
        else if (!isAbortedRequest(error) && currentSelection() && timedThreadRef.current !== threadId) {
          const message = error instanceof Error ? error.message : String(error);
          timingErrorRef.current = message;
          setLastError(message);
        }
      });
      try {
        let response = await historyRequestsRef.current.get<OpenThreadPage & {
          result: { thread: Thread; collaborationMode?: CollaborationMode } & PermissionSettings
        }>(path, historyConfig.readTimeoutMs, 3);
        if (response.snapshot?.stale) {
          preview(response.result.thread, response);
          response = await historyRequestsRef.current.get(`${path}&fresh=1`, historyConfig.readTimeoutMs, 3);
        }
        if (!currentSelection()) return;
        nativeArrived = true;
        const { result, ...page } = response;
        const thread = {
          ...result.thread, permissionProfile: permissionProfileId(result), archived: Boolean(archived),
          ...(result.collaborationMode ? { collaborationMode: result.collaborationMode } : {})
        };
        const historyItems = page.items.map((entry) => ({
          ...entry.item, turnId: entry.turnId,
          startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs
        }));
        if (version !== selectionVersionRef.current || activeThreadRef.current !== threadId) return;
        historyCacheRef.current.delete(threadId);
        historyCacheRef.current.set(threadId, page);
        if (historyCacheRef.current.size > 5) historyCacheRef.current.delete(historyCacheRef.current.keys().next().value!);
        flushStreamingDeltas();
        const historyKeys = new Set(historyItems.map(itemKey));
        const preserveHistory =
          Boolean(options.preserveHistory) && baseline.some((item) => historyKeys.has(itemKey(item)));
        setActiveThreadId(threadId);
        setActiveThread(thread);
        setVerifiedThreadId(threadId);
        verifiedThreadRef.current = threadId;
        if (!page.timingsPending && turnRevisionRef.current === turnRevision) {
          activeTurnIdRef.current = page.activeTurnId;
          setActiveTurnId(page.activeTurnId);
        }
        setTurnTimings((current) => {
          const timings = mergeTurnTimings(current, page.turns, timingBaseline);
          turnTimingsRef.current = timings;
          return timings;
        });
        if (!page.timingsPending && !options.preserveHistory) turnsCursorRef.current = page.turnsCursor;
        setItems((current) => {
          if (preserveHistory) return mergeLatestHistoryItems(current, historyItems, baseline);
          const baselineById = new Map(baseline.map((item) => [itemKey(item), item]));
          const liveItems = current.filter((item) => baselineById.get(itemKey(item)) !== item);
          const currentById = new Map(current.map(item => [itemKey(item), item]));
          const stable = historyItems.map(item => {
            const previous = currentById.get(itemKey(item));
            return previous && JSON.stringify(previous) === JSON.stringify(item) ? previous : item;
          });
          return mergeLatestHistoryItems(stable, liveItems);
        });
        markStartup('chat');
        if (!preserveHistory) {
          olderHistoryCursorRef.current = page.nextCursor;
          setHasMoreHistory(page.nextCursor !== null);
        }
      } catch (error) {
        if (isAbortedRequest(error)) return;
        if (error instanceof HttpError && error.status === 401) {
          authExpiredRef.current?.();
          return;
        }
        if (version === selectionVersionRef.current) setLastError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        endForeground();
        if (version === selectionVersionRef.current) {
          if (!options.silent) setLoadingHistory(false);
          if (!options.silent) setLoadingThread(false);
        }
      }
    },
    [clearStreamingDeltas, flushStreamingDeltas, watchThread]
  );

  useEffect(() => {
    if (!authenticated || !connected || !verifiedThreadId || verifiedThreadId !== activeThreadId || showArchived) {
      setThreadReady(false);
      return;
    }
    if (newThreadsRef.current.has(verifiedThreadId)) { setThreadReady(true); return; }
    let stopped = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    let resumeError: string | null = null;
    const socket = socketRef.current;
    const currentSelection = () => !stopped && socketRef.current === socket &&
      activeThreadRef.current === verifiedThreadId;
    setThreadReady(false);
    const resume = () => {
      if (!currentSelection()) return;
      attempts++;
      // Only rejoin this existing subscription; never retry turn or model actions.
      void rpc<{ thread: Thread } & PermissionSettings>('thread/resume', {
        threadId: verifiedThreadId, excludeTurns: true
      }).then(result => {
        if (!currentSelection()) return;
        setActiveThread(current => current?.id === verifiedThreadId
          ? { ...current, ...result.thread, permissionProfile: permissionProfileId(result) } : current);
        setThreadReady(true);
        if (resumeError) setLastError(current => current === resumeError
          ? metadataErrorsRef.current.models ?? metadataErrorsRef.current.projects ?? null : current);
        markStartup('chat-interactive');
      }).catch(error => {
        if (!currentSelection()) return;
        resumeError = error instanceof Error ? error.message : String(error);
        setLastError(resumeError);
        if (attempts < 3) retryTimer = window.setTimeout(resume, 500 * 2 ** (attempts - 1));
      });
    };
    resume();
    return () => { stopped = true; window.clearTimeout(retryTimer); };
  }, [authenticated, connected, verifiedThreadId, activeThreadId, showArchived, rpc]);

  const prepareEarlierHistory = useCallback(() => {
    const threadId = activeThreadRef.current;
    const cursor = olderHistoryCursorRef.current;
    const version = selectionVersionRef.current;
    if (!threadId || cursor === null) return null;
    return earlierPageRef.current.read(JSON.stringify([version, threadId, cursor]), async signal => {
      const turnRevision = turnRevisionRef.current;
      const [page, initialTimings] = await Promise.all([
        fetchHistoryPage(threadId, cursor),
        timedThreadRef.current === threadId ? Promise.resolve(null)
          : historyRequestsRef.current.get<Pick<ThreadHistoryPage, 'turns' | 'turnsCursor' | 'activeTurnId'>>(
            `/api/thread/timings?${new URLSearchParams({ threadId, fresh: '1' })}`, historyConfig.readTimeoutMs, 3)
      ]);
      signal.throwIfAborted();
      if (initialTimings && timedThreadRef.current !== threadId &&
          version === selectionVersionRef.current && activeThreadRef.current === threadId) {
        setTurnTimings(current => {
          const next = mergeOlderTurnTimings(current, initialTimings.turns);
          turnTimingsRef.current = next;
          return next;
        });
        if (turnRevisionRef.current === turnRevision) {
          activeTurnIdRef.current = initialTimings.activeTurnId;
          setActiveTurnId(initialTimings.activeTurnId);
        }
        turnsCursorRef.current = initialTimings.turnsCursor;
        timedThreadRef.current = threadId;
        setTimedThreadId(threadId);
        const previousError = timingErrorRef.current;
        timingErrorRef.current = null;
        if (previousError) setLastError(current => current === previousError ? null : current);
      }
      const prepared = await prepareHistoryPage(
        async () => page,
        async turnsCursor => {
          const result = await historyRequestsRef.current.get<Pick<ThreadHistoryPage, 'turns' | 'turnsCursor'>>(
            `/api/thread/timings?${new URLSearchParams({ threadId, cursor: turnsCursor })}`, historyConfig.readTimeoutMs, 3);
          return { data: result.turns, nextCursor: result.turnsCursor };
        },
        { ...turnTimingsRef.current, ...Object.fromEntries(initialTimings?.turns.map(turn => [turn.id, turn]) ?? []) },
        initialTimings ? initialTimings.turnsCursor : turnsCursorRef.current, signal
      );
      return initialTimings ? { ...prepared, turns: [...initialTimings.turns, ...prepared.turns] } : prepared;
    });
  }, [fetchHistoryPage]);

  const prefetchEarlierHistory = useCallback(async () => {
    if (loadingHistoryRef.current) return;
    // Speculation never changes loading/error state; a foreground read can retry.
    try { await prepareEarlierHistory(); } catch { /* Retain the visible conversation. */ }
  }, [prepareEarlierHistory]);

  const loadEarlierHistory = useCallback(async (beforeCommit?: BeforeHistoryCommit) => {
    const threadId = activeThreadRef.current;
    const cursor = olderHistoryCursorRef.current;
    const version = selectionVersionRef.current;
    if (!threadId || cursor === null || loadingHistoryRef.current) return;
    loadingHistoryRef.current = true;
    setLoadingHistory(true);
    try {
      const page = await prepareEarlierHistory();
      if (!page) return;
      if (beforeCommit && !await beforeCommit()) return;
      if (threadId !== activeThreadRef.current || version !== selectionVersionRef.current) return;
      const olderItems = page.items.map((entry) => ({
        ...entry.item, turnId: entry.turnId,
        startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs
      }));
      turnsCursorRef.current = page.turnsCursor;
      if (page.turns.length > 0) setTurnTimings((current) => {
        const next = mergeOlderTurnTimings(current, page.turns);
        turnTimingsRef.current = next;
        return next;
      });
      setItems((current) => mergeOlderHistoryItems(olderItems, current));
      olderHistoryCursorRef.current = page.nextCursor;
      earlierPageRef.current.clear();
      setHasMoreHistory(page.nextCursor !== null);
    } catch (error) {
      if (version === selectionVersionRef.current && !isAbortedRequest(error)) {
        setLastError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (version === selectionVersionRef.current) {
        loadingHistoryRef.current = false;
        setLoadingHistory(false);
      }
    }
  }, [prepareEarlierHistory]);

  const loadLaterHistory = useCallback(async () => {
    const threadId = activeThreadRef.current;
    const cursor = newerHistoryCursorRef.current;
    const version = selectionVersionRef.current;
    if (!threadId || !cursor || loadingHistoryRef.current) return;
    loadingHistoryRef.current = true;
    setLoadingLaterHistory(true);
    try {
      const page = await fetchHistoryPage(threadId, cursor, 'after');
      if (version !== selectionVersionRef.current || threadId !== activeThreadRef.current) return;
      const later = page.items.map(entry => ({ ...entry.item, turnId: entry.turnId,
        startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs }));
      setItems(current => mergeLatestHistoryItems(current, later));
      newerHistoryCursorRef.current = page.nextCursor;
      setHasNewerHistory(page.nextCursor !== null);
    } catch (error) {
      if (version === selectionVersionRef.current && !isAbortedRequest(error)) {
        setLastError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (version === selectionVersionRef.current) {
        loadingHistoryRef.current = false;
        setLoadingLaterHistory(false);
      }
    }
  }, [fetchHistoryPage]);

  const revealHistory = useCallback(async (turnId: string, itemId: string): Promise<boolean> => {
    const threadId = activeThreadRef.current;
    if (!threadId) return false;
    const wasViewing = viewingHistoryRef.current;
    const version = ++selectionVersionRef.current;
    earlierPageRef.current.clear();
    historyRequestsRef.current.cancel();
    pendingRevealRef.current = { version, wasViewing };
    clearStreamingDeltas();
    viewingHistoryRef.current = true;
    setViewingHistory(true);
    setRevealingHistory(true);
    loadingHistoryRef.current = true;
    setLoadingThread(false);
    setLoadingHistory(false);
    setLoadingLaterHistory(false);
    try {
      const query = new URLSearchParams({ threadId, turnId, itemId });
      const cacheKey = query.toString();
      const revision = navigationRevisionRef.current;
      const cached = navigationCacheRef.current.get(cacheKey);
      const startedAt = performance.now();
      const page = cached && Date.now() - cached.savedAt < historyConfig.navigationCacheMs ? cached.page
        : await historyRequestsRef.current.get<Pick<ThreadHistoryPage, 'items' | 'nextCursor'> & { newerCursor: string | null }>(
          `/api/thread/around?${query}`);
      if (version !== selectionVersionRef.current || threadId !== activeThreadRef.current) return false;
      navigationCacheRef.current.delete(cacheKey);
      if (revision === navigationRevisionRef.current) {
        navigationCacheRef.current.set(cacheKey, { threadId, turnId, savedAt: Date.now(), page });
      }
      if (navigationCacheRef.current.size > historyConfig.navigationCacheWindows) navigationCacheRef.current.delete(navigationCacheRef.current.keys().next().value!);
      console.debug('[turn-navigation] window ready', { cached: page === cached?.page,
        count: page.items.length, elapsedMs: Math.round(performance.now() - startedAt) });
      const windowItems = page.items.map(entry => ({ ...entry.item, turnId: entry.turnId,
        startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs }));
      setItems(windowItems);
      olderHistoryCursorRef.current = page.nextCursor;
      newerHistoryCursorRef.current = page.newerCursor;
      setHasMoreHistory(page.nextCursor !== null);
      setHasNewerHistory(page.newerCursor !== null);
      return windowItems.some(item => item.turnId === turnId && item.id === itemId);
    } catch (error) {
      if (version === selectionVersionRef.current) {
        viewingHistoryRef.current = wasViewing;
        setViewingHistory(wasViewing);
        setLastError(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (version === selectionVersionRef.current) {
        pendingRevealRef.current = null;
        loadingHistoryRef.current = false;
        setRevealingHistory(false);
      }
    }
  }, [clearStreamingDeltas]);

  const cancelHistoryReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    if (!pending) return;
    selectionVersionRef.current += 1;
    historyRequestsRef.current.cancel();
    earlierPageRef.current.clear();
    pendingRevealRef.current = null;
    viewingHistoryRef.current = pending.wasViewing;
    setViewingHistory(pending.wasViewing);
    loadingHistoryRef.current = false;
    setRevealingHistory(false);
  }, []);

  const returnToLatest = useCallback(async () => {
    const threadId = activeThreadRef.current;
    if (threadId) await openThread(threadId);
  }, [openThread]);

  useEffect(() => {
    if (!authenticated) return;
    let stopped = false;
    void readDeviceWorkspace().then(saved => {
      if (stopped || !saved) return;
      if (!nativeListSeenRef.current) {
        setThreads(current => {
          if (current.length) return current;
          saved.threads.forEach(thread => provisionalListRef.current.set(thread.id, thread));
          return saved.threads;
        });
        markStartup('tasks-device');
      }
      if (!nativeProjectsSeenRef.current) setProjects(current => current.length ? current : saved.projects);
    });
    return () => { stopped = true; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || showArchived || !nativeListSeenRef.current) return;
    const timer = window.setTimeout(() => { void saveDeviceWorkspace(threadsRef.current, projects); }, 700);
    return () => window.clearTimeout(timer);
  }, [authenticated, showArchived, threads, projects]);

  useEffect(() => {
    if (!authenticated || !activeThread || activeThread.id !== verifiedThreadId ||
      activeThread.id !== timedThreadId || showArchived) return;
    const timer = window.setTimeout(() => {
      if (activeThreadRef.current !== activeThread.id || verifiedThreadRef.current !== activeThread.id) return;
      void saveDeviceChat(activeThread, {
        items: items.slice(-40).map(item => ({
          item, turnId: item.turnId ?? '', startedAtMs: item.startedAtMs ?? null, completedAtMs: item.completedAtMs ?? null
        })),
        turns: Object.values(turnTimings), activeTurnId, nextCursor: null, turnsCursor: null
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [authenticated, activeThread, verifiedThreadId, timedThreadId, showArchived, items, turnTimings, activeTurnId]);

  useEffect(() => {
    setOutlineTurns(current => mergeOutlineTurns(current, loadedOutline(items, turnTimings)));
  }, [items, turnTimings]);

  useEffect(() => {
    if (!authenticated || !activeThreadId || showArchived || newThreadsRef.current.has(activeThreadId)) {
      setActiveGoal(null);
      return;
    }
    const controller = new AbortController();
    const revision = ++goalRevisionRef.current;
    const threadId = activeThreadId;
    const startedAt = performance.now();
    console.debug('[thread-dock] goal read started', { connected });
    void api<{ goal: unknown }>(`/api/thread/dock/goal?${new URLSearchParams({ threadId })}`, {
      cache: 'no-store', signal: controller.signal, timeoutMs: historyConfig.readTimeoutMs
    }).then(result => {
      console.debug('[thread-dock] goal read finished', { elapsedMs: performance.now() - startedAt, present: Boolean(result.goal) });
      if (!controller.signal.aborted && goalRevisionRef.current === revision && activeThreadRef.current === threadId) {
        setActiveGoal(parseThreadGoal(result));
      }
    }).catch(error => {
      if (controller.signal.aborted || isAbortedRequest(error)) return;
      if (error instanceof HttpError && error.status === 401) authExpiredRef.current?.();
      else console.warn('[thread-dock] could not read thread goal', error);
    });
    return () => controller.abort();
  }, [activeThreadId, authenticated, connected, showArchived]);

  useEffect(() => {
    if (!activeThreadId) return;
    const controller = new AbortController();
    const threadId = activeThreadId;
    setOutlineError(null);
    const readPage = async (cursor: string | null) => {
        await yieldToInteraction(controller.signal);
        const query = new URLSearchParams({ threadId, ...(cursor ? { cursor } : {}) });
        const page: { turns: OutlineTurn[]; nextCursor: string | null } = await api(
          `/api/thread/outline?${query}`, { cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted || threadId !== activeThreadRef.current) return null;
        setOutlineTurns(current => mergeOutlineTurns(current, page.turns, true));
        setTurnTimings(current => {
          const next = { ...current };
          for (const { messages: _messages, ...timing } of page.turns) {
            if (!next[timing.id] || next[timing.id]!.status === 'inProgress') next[timing.id] = timing;
          }
          return next;
        });
        return page.nextCursor;
    };
    const failed = (error: unknown) => {
      if (!controller.signal.aborted) setOutlineError(error instanceof Error ? error.message : String(error));
    };
    let headRequest: Promise<unknown> | null = null;
    outlineRefreshRef.current = () => {
      if (headRequest) return;
      headRequest = readPage(null).catch(failed).finally(() => { headRequest = null; });
    };
    void (async () => {
      let cursor: string | null = null;
      do {
        const nextCursor = await readPage(cursor);
        if (nextCursor === cursor) break;
        cursor = nextCursor;
      } while (cursor);
    })().catch(failed);
    return () => { controller.abort(); outlineRefreshRef.current = null; };
  }, [activeThreadId]);

  const closeThread = useCallback(() => {
    selectionVersionRef.current += 1;
    earlierPageRef.current.clear();
    historyRequestsRef.current.cancel();
    activeThreadRef.current = null;
    watchThread(null);
    clearStreamingDeltas();
    olderHistoryCursorRef.current = null;
    newerHistoryCursorRef.current = null;
    viewingHistoryRef.current = false;
    setViewingHistory(false);
    setHasNewerHistory(false);
    setLoadingLaterHistory(false);
    setRevealingHistory(false);
    setOutlineTurns([]);
    loadingHistoryRef.current = false;
    setActiveThreadId(null);
    setActiveThread(null);
    setActiveGoal(null);
    setActiveTurnId(null);
    setItems([]);
    setTurnTimings({});
    turnTimingsRef.current = {};
    turnsCursorRef.current = null;
    setHasMoreHistory(false);
    setLoadingHistory(false);
    setLoadingThread(false);
    setThreadReady(false);
    setVerifiedThreadId(null);
    setTimedThreadId(null);
    verifiedThreadRef.current = null;
  }, [clearStreamingDeltas, watchThread]);

  const createThread = useCallback(
    async (options: CreateThreadOptions = {}) => {
      clearStreamingDeltas();
      const result = await rpc<{ thread: Thread } & PermissionSettings>('thread/start', {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.permissions ? permissionProfileUpdate(options.permissions) : {})
      });
      newThreadsRef.current.add(result.thread.id);
      let thread = { ...result.thread, permissionProfile: permissionProfileId(result) };
      if (options.effort || options.collaborationMode) {
        await rpc('thread/settings/update', {
          threadId: thread.id,
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {})
        });
        thread = {
          ...thread,
          ...(options.effort ? { reasoningEffort: options.effort } : {}),
          ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {})
        };
      }
      setThreads((current) => dedupeThreads([...current, thread]));
      selectionVersionRef.current += 1;
      earlierPageRef.current.clear();
      historyRequestsRef.current.cancel();
      activeThreadRef.current = thread.id;
      watchThread(thread.id);
      setActiveThreadId(result.thread.id);
      setActiveThread(thread);
      setThreadReady(true);
      setVerifiedThreadId(thread.id);
      verifiedThreadRef.current = thread.id;
      setTimedThreadId(thread.id);
      olderHistoryCursorRef.current = null;
      newerHistoryCursorRef.current = null;
      viewingHistoryRef.current = false;
      setViewingHistory(false);
      setHasNewerHistory(false);
      setLoadingLaterHistory(false);
      setRevealingHistory(false);
      setOutlineTurns([]);
      loadingHistoryRef.current = false;
      setActiveTurnId(null);
      setItems([]);
      setTurnTimings({});
      turnTimingsRef.current = {};
      turnsCursorRef.current = null;
      setHasMoreHistory(false);
      setLoadingHistory(false);
      return thread;
    },
    [clearStreamingDeltas, rpc, watchThread]
  );

  const sendTurn = useCallback(
    async (threadId: string, text: string, settings: ThreadSettingsPatch = {}, attachments: ComposerAttachment[] = [], skills: SkillInfo[] = []) => {
      const clean = text.trim();
      if (!clean && attachments.length === 0 && skills.length === 0) return;

      if (!newThreadsRef.current.has(threadId)) await rpc('thread/resume', { threadId, excludeTurns: true });
      const result = await rpc<{ turn: TurnTiming }>('turn/start', {
        threadId,
        input: turnInput(clean, attachments, skills),
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.permissions ? permissionProfileUpdate(settings.permissions) : {}),
        ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {})
      });
      newThreadsRef.current.delete(threadId);
      if (result.turn?.id && activeThreadRef.current === threadId) {
        turnRevisionRef.current += 1;
        activeTurnIdRef.current = result.turn.id;
        setActiveTurnId(result.turn.id);
        setTurnTimings((current) => ({ ...current, [result.turn.id]: result.turn }));
      }
      return result.turn?.id;
    },
    [rpc]
  );

  const setThreadSettings = useCallback(
    async (threadId: string, settings: ThreadSettingsPatch) => {
      await rpc('thread/settings/update', {
        threadId, ...settings,
        ...(settings.permissions ? permissionProfileUpdate(settings.permissions) : {})
      });
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                ...(settings.model ? { model: settings.model } : {}),
                ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
                ...(settings.permissions ? { permissionProfile: settings.permissions } : {}),
                ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {})
              }
            : thread
        )
      );
      setActiveThread((current) =>
        current?.id === threadId
          ? {
              ...current,
              ...(settings.model ? { model: settings.model } : {}),
              ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
              ...(settings.permissions ? { permissionProfile: settings.permissions } : {}),
              ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {})
            }
          : current
      );
    },
    [rpc]
  );

  const renameThread = useCallback(async (threadId: string, name: string) => {
    await rpc('thread/name/set', { threadId, name });
    setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, name } : thread));
    setActiveThread((current) => current?.id === threadId ? { ...current, name } : current);
  }, [rpc]);

  const archiveThread = useCallback(async (threadId: string, archived: boolean) => {
    await rpc(archived ? 'thread/archive' : 'thread/unarchive', { threadId });
    if (activeThreadRef.current === threadId) closeThread();
    await refreshThreads();
  }, [closeThread, refreshThreads, rpc]);

  const toggleArchived = useCallback(async () => {
    closeThread();
    archivedRef.current = !archivedRef.current;
    setShowArchived(archivedRef.current);
    setThreads([]);
    provisionalListRef.current.clear();
    listPaginationRef.current?.abort();
    listRequestsRef.current.cancel();
    await listRefreshRef.current?.catch(() => undefined);
    await refreshThreads();
  }, [closeThread, refreshThreads]);

  const listSkills = useCallback(async (cwd?: string): Promise<SkillsResult> => {
    const result = await rpc<{ data: Array<{ skills: SkillInfo[]; errors: SkillsResult['errors'] }> }>(
      'skills/list', { ...(cwd ? { cwds: [cwd] } : {}) }
    );
    return {
      skills: [...new Map(result.data.flatMap((entry) => entry.skills).map((skill) => [skill.path, skill])).values()],
      errors: result.data.flatMap((entry) => entry.errors)
    };
  }, [rpc]);

  const listModes = useCallback(() => rpc<{ data: Array<{ mode: string | null }> }>('collaborationMode/list'), [rpc]);

  const listMcp = useCallback(async (threadId?: string) => {
    const data: McpStatus[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: McpStatus[]; nextCursor?: string | null } = await rpc('mcpServerStatus/list', {
        limit: 100, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {})
      });
      data.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return data;
  }, [rpc]);

  const compactThread = useCallback(async (threadId: string) => {
    await rpc('thread/compact/start', { threadId });
  }, [rpc]);

  const reviewThread = useCallback(async (threadId: string, target: ReviewTarget) => {
    const result = await rpc<{ turn: { id: string } }>('review/start', { threadId, target, delivery: 'inline' });
    if (activeThreadRef.current === threadId && result.turn?.id) {
      turnRevisionRef.current += 1;
      activeTurnIdRef.current = result.turn.id;
      setActiveTurnId(result.turn.id);
    }
  }, [rpc]);

  const forkThread = useCallback(async (threadId: string, lastTurnId?: string) => {
    const result = await rpc<{ thread: Thread }>('thread/fork', {
      threadId, excludeTurns: true, deferGoalContinuation: true, ...(lastTurnId ? { lastTurnId } : {})
    });
    setThreads((current) => dedupeThreads([...current, result.thread]));
    await openThread(result.thread.id);
    await refreshThreads();
  }, [rpc, openThread, refreshThreads]);

  const refreshActiveHistory = useCallback(() => {
    const threadId = activeThreadRef.current;
    if (!threadId || historyRefreshRef.current || viewingHistoryRef.current) return;
    historyRefreshRef.current = openThread(threadId, { silent: true, preserveHistory: true })
      .catch(() => undefined)
      .finally(() => { historyRefreshRef.current = null; });
  }, [openThread]);

  const steerTurn = useCallback(
    async (threadId: string, turnId: string, text: string, attachments: ComposerAttachment[] = [], skills: SkillInfo[] = []) => {
      await rpc('turn/steer', { threadId, expectedTurnId: turnId, input: turnInput(text, attachments, skills) });
    },
    [rpc]
  );

  const setGoal = useCallback(async (threadId: string, update: GoalUpdate) => {
    const params = goalUpdateParams(threadId, update);
    const revision = ++goalRevisionRef.current;
    console.debug('[thread-dock] goal update started', { status: update.status, editing: update.objective !== undefined });
    const result = await rpc<{ goal: unknown }>('thread/goal/set', params);
    const goal = parseThreadGoal(result);
    if (!goal || goal.threadId !== threadId) throw new Error('Invalid goal update response.');
    if (activeThreadRef.current === threadId && goalRevisionRef.current === revision) setActiveGoal(goal);
    console.debug('[thread-dock] goal update finished', { status: goal.status });
  }, [rpc]);

  const clearGoal = useCallback(async (threadId: string) => {
    const revision = ++goalRevisionRef.current;
    console.debug('[thread-dock] goal clear started');
    const result = await rpc<{ cleared: boolean }>('thread/goal/clear', { threadId, origin: 'user' });
    if (typeof result.cleared !== 'boolean') throw new Error('Invalid goal clear response.');
    if (activeThreadRef.current === threadId && goalRevisionRef.current === revision) setActiveGoal(null);
    console.debug('[thread-dock] goal clear finished', { cleared: result.cleared });
  }, [rpc]);

  const interruptTurn = useCallback(
    async (threadId: string, turnId: string) => {
      await rpc('turn/interrupt', { threadId, turnId });
    },
    [rpc]
  );

  const scheduleThreadRefresh = useCallback((threadId?: string) => {
    dirtyThreadIdsRef.current.add(threadId || '*');
    if (refreshThreadsTimerRef.current) window.clearTimeout(refreshThreadsTimerRef.current);
    refreshThreadsTimerRef.current = window.setTimeout(() => {
      refreshThreadsTimerRef.current = null;
      const ids = [...dirtyThreadIdsRef.current];
      dirtyThreadIdsRef.current.clear();
      void (async () => {
        await yieldToInteraction();
        if (ids.includes('*')) { await refreshThreads(); return; }
        for (const threadId of ids) {
          const { thread } = await rpc<{ thread: Thread }>('thread/read', { threadId, includeTurns: false });
          if (isTaskThread(thread) && Boolean(thread.archived) === archivedRef.current) {
            setThreads(current => dedupeThreads([...current.filter(entry => entry.id !== thread.id), thread]));
          } else {
            setThreads(current => current.filter(entry => entry.id !== thread.id));
          }
        }
      })().catch(() => undefined);
    }, 800);
  }, [refreshThreads, rpc]);

  const rejectPendingServerResponses = useCallback((error: Error) => {
    for (const pending of pendingServerResponsesRef.current.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingServerResponsesRef.current.clear();
  }, []);

  const respondToRequest = useCallback((request: ServerRequest, result: unknown): Promise<void> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Remote connection is not ready.'));
    }

    const key = requestKey(request.requestId);
    const existing = pendingServerResponsesRef.current.get(key);
    if (existing) {
      window.clearTimeout(existing.timeout);
      existing.reject(new Error('A newer approval response replaced this request.'));
      pendingServerResponsesRef.current.delete(key);
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingServerResponsesRef.current.delete(key);
        reject(new Error('Approval response was not acknowledged.'));
      }, 10_000);
      pendingServerResponsesRef.current.set(key, { resolve, reject, timeout });
      try {
        socket.send(
          JSON.stringify({
            type: 'server.request.respond',
            requestId: request.requestId,
            result
          })
        );
      } catch (error) {
        window.clearTimeout(timeout);
        pendingServerResponsesRef.current.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    if (!authenticated) return;
    let stopped = false;
    let initialThreadsLoaded = false;
    const loadInitialThreads = (page?: NonNullable<WorkspaceBootstrap['threads']>) => {
      if (initialThreadsLoaded) return Promise.resolve(threadsRef.current);
      return refreshThreads(archivedRef.current ? undefined : page).then(result => {
        initialThreadsLoaded = true;
        return result;
      });
    };
    const reportInitialFailure = (error: unknown) => {
      if (!stopped && !isAbortedRequest(error)) setLastError(error instanceof Error ? error.message : String(error));
    };
    const bootstrapTimer = window.setTimeout(() => {
      if (!stopped) void loadInitialThreads().catch(reportInitialFailure);
    }, 1500);
    const snapshotRequest = Promise.resolve(bootstrap ?? bootstrapRequest ?? null).then(snapshot => {
      if (stopped) return null;
      if (!nativeModelsSeenRef.current && metadataVersionsRef.current.models === 0 && snapshot?.models) {
        nativeModelsSeenRef.current = true;
        setModels(snapshot.models.data ?? []);
      }
      if (!nativeProjectsSeenRef.current && metadataVersionsRef.current.projects === 0 && snapshot?.projects) {
        nativeProjectsSeenRef.current = true;
        setProjects(snapshot.projects.data ?? []);
      }
      if (snapshot?.cursor && !replayCursorRef.current) replayCursorRef.current = snapshot.cursor;
      return snapshot;
    });
    // Catalogs must not wait for a working realtime route or for each other.
    let metadataTimer: number | undefined;
    const metadataSnapshot = Promise.race([
      snapshotRequest.catch(() => null),
      new Promise<null>(resolve => { metadataTimer = window.setTimeout(() => resolve(null), 1500); })
    ]).finally(() => window.clearTimeout(metadataTimer));
    const loadMetadata = async (kind: 'models' | 'projects') => {
      try {
        const snapshot = await metadataSnapshot;
        if (stopped || snapshot?.[kind] || metadataVersionsRef.current[kind] > 0) return;
        await refreshMetadata(kind);
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) authExpiredRef.current?.();
        else if (!stopped && !isAbortedRequest(error)) setLastError(error instanceof Error ? error.message : String(error));
      }
    };
    const recoverMetadata = () => {
      if (stopped || document.visibilityState !== 'visible' || !navigator.onLine) return;
      for (const kind of ['models', 'projects'] as const) {
        const seen = kind === 'models' ? nativeModelsSeenRef.current : nativeProjectsSeenRef.current;
        if (!seen || metadataFailuresRef.current.has(kind)) {
          void refreshMetadata(kind).catch(reportInitialFailure);
        }
      }
    };
    retryMetadataRef.current = recoverMetadata;
    void loadMetadata('models');
    void loadMetadata('projects');
    // HTTP can populate and page tasks while the socket is still connecting.
    void snapshotRequest.then(snapshot => {
      window.clearTimeout(bootstrapTimer);
      if (!stopped) return loadInitialThreads(snapshot?.threads ?? undefined);
    }).catch(reportInitialFailure);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new RemoteConnection({
      url: `${protocol}//${window.location.host}/ws`,
      httpFallback: '/api/connection',
      readyType: 'sync.ready',
      onSocket: (socket) => { socketRef.current = socket; },
      onOpen: () => {
        const cursor = replayCursorRef.current;
        socketRef.current?.send(JSON.stringify({ type: 'sync.resume',
          epoch: cursor?.epoch ?? null, after: cursor?.sequence ?? 0,
          threadId: activeThreadRef.current, additionalThreadIds: additionalThreadsRef.current }));
      },
      onMessage: (message) => {
        if (message.type !== 'sync.ready') { handleMessage(message); return; }
        replayCursorRef.current = { epoch: message.epoch, sequence: message.sequence };
        lastRecoveryRef.current = Date.now();
        setConnected(true);
        markStartup('connected');
        setLastError(null);
        watchThread(activeThreadRef.current);
        const initial = !initializedRef.current;
        if (!initial && !message.resumed) {
          void refreshMetadata('models').catch(reportInitialFailure);
          void refreshMetadata('projects').catch(reportInitialFailure);
        } else recoverMetadata();
        if (listFailuresRef.current > 0) retryThreadsRef.current();
        const threadId = activeThreadRef.current;
        if (threadId && (!message.resumed ||
            verifiedThreadRef.current !== threadId || timedThreadRef.current !== threadId)) {
          void openThread(threadId, { silent: true, preserveHistory: true }).catch(() => undefined);
        }
        if (message.resumed && initializedRef.current) return;
        const socket = socketRef.current;
        void (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const snapshot = initial ? await Promise.race([
            snapshotRequest,
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })
          ]).finally(() => clearTimeout(timer)) : null;
          if (stopped || socketRef.current !== socket) return;
          const results = await Promise.allSettled([
            initial ? loadInitialThreads(snapshot?.threads ?? undefined) : refreshThreads()
          ]);
          if (socketRef.current === socket && results.every(result => result.status === 'fulfilled')) {
            initializedRef.current = true;
          }
        })();
        outlineRefreshRef.current?.();
      },
      onDisconnect: (error) => {
        if ('status' in error && error.status === 401) { authExpiredRef.current?.(); return; }
        setConnected(false);
        setLastError(error.message);
        flushStreamingDeltas();
        for (const pending of pendingRef.current.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(error);
        }
        pendingRef.current.clear();
        rejectPendingServerResponses(error);
      }
    });
    connectionRef.current = connection;
    let tasksWereHidden = document.visibilityState !== 'visible';
    let tasksWereOffline = !navigator.onLine;
    const recoverTasks = (event: Event) => {
      let resumed = false;
      if (event.type === 'offline') { tasksWereOffline = true; return; }
      if (event.type === 'online') {
        resumed = tasksWereOffline;
        tasksWereOffline = false;
      }
      if (event.type === 'visibilitychange') {
        resumed = tasksWereHidden && document.visibilityState === 'visible';
        tasksWereHidden = document.visibilityState !== 'visible';
      }
      if (stopped || document.visibilityState !== 'visible' || !navigator.onLine) return;
      recoverMetadata();
      if (resumed && listFirstPagePendingRef.current && Date.now() - listStartedAtRef.current >= 2000) restartTaskRead();
      else if (listFailuresRef.current > 0) retryThreadsRef.current();
    };
    window.addEventListener('online', recoverTasks);
    window.addEventListener('offline', recoverTasks);
    window.addEventListener('focus', recoverTasks);
    document.addEventListener('visibilitychange', recoverTasks);
    connection.start();
    return () => {
      stopped = true;
      window.clearTimeout(bootstrapTimer);
      window.clearTimeout(metadataTimer);
      metadataRequestsRef.current.cancel();
      retryMetadataRef.current = () => {};
      window.clearTimeout(listRetryTimerRef.current);
      window.removeEventListener('online', recoverTasks);
      window.removeEventListener('offline', recoverTasks);
      window.removeEventListener('focus', recoverTasks);
      document.removeEventListener('visibilitychange', recoverTasks);
      disposedRef.current = true;
      earlierPageRef.current.clear();
      selectionVersionRef.current += 1;
      permissionRequestVersionRef.current += 1;
      historyRequestsRef.current.cancel();
      permissionRequestsRef.current.cancel();
      listPaginationRef.current?.abort();
      listRequestsRef.current.cancel();
      if (refreshThreadsTimerRef.current) window.clearTimeout(refreshThreadsTimerRef.current);
      clearStreamingDeltas();
      connection.dispose();
      if (connectionRef.current === connection) connectionRef.current = null;
      listRefreshRef.current = null;
      for (const pending of pendingRef.current.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error('Remote connection closed.'));
      }
      pendingRef.current.clear();
      rejectPendingServerResponses(new Error('Remote connection closed.'));
    };
  }, [authenticated, bootstrap, bootstrapRequest, clearStreamingDeltas, flushStreamingDeltas, openThread, refreshMetadata, refreshThreads, rejectPendingServerResponses, restartTaskRead, rpc, watchThread]);

  useEffect(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      watchThread(activeThreadId);
    }
  }, [activeThreadId, connected]);

  useEffect(() => {
    if (!authenticated || !connected) return;
    const recover = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRecoveryRef.current < 300_000) return;
      lastRecoveryRef.current = Date.now();
      void refreshThreads().catch(() => undefined);
      refreshActiveHistory();
    };
    const timer = window.setInterval(recover, 300_000);
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [authenticated, connected, refreshActiveHistory, refreshThreads]);

  function handleMessage(message: ServerMessage): void {
    if (message.sequence != null && message.epoch && replayCursorRef.current?.epoch !== message.epoch) {
      replayCursorRef.current = { epoch: message.epoch, sequence: 0 };
    }
    if (message.sequence != null && replayCursorRef.current) {
      if (message.sequence <= replayCursorRef.current.sequence) return;
      replayCursorRef.current.sequence = message.sequence;
    }
    if (message.type === 'rpc.result') {
      const pending = pendingRef.current.get(message.id);
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingRef.current.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }

    if (message.type === 'rpc.error') {
      const pending = pendingRef.current.get(message.id);
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingRef.current.delete(message.id);
        pending.reject(new Error(message.error.message));
      }
      return;
    }

    if (message.type === 'bridge.status') {
      setBridgeStatus({ status: message.status, ...(message.message ? { message: message.message } : {}) });
      if (message.status === 'ready' && replayCursorRef.current) {
        lastRecoveryRef.current = 0;
      }
      return;
    }

    if (message.type === 'questions.snapshot') {
      setQuestionCounts(Object.fromEntries(Object.entries(message.counts ?? {}).filter(([id, count]) =>
        id && Number.isSafeInteger(count) && count > 0)));
      return;
    }

    if (message.type === 'server.request.snapshot') {
      setServerRequests(
        message.requests.map((request) => ({
          requestId: request.requestId,
          method: request.method,
          params: request.params as Record<string, unknown>
        }))
      );
      return;
    }

    if (message.type === 'server.request') {
      setServerRequests((current) => [
        ...current.filter((entry) => requestKey(entry.requestId) !== requestKey(message.requestId)),
        { requestId: message.requestId, method: message.method, params: message.params as Record<string, unknown> }
      ]);
      return;
    }

    if (message.type === 'server.request.resolved') {
      const key = requestKey(message.requestId);
      const pending = pendingServerResponsesRef.current.get(key);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pending.resolve();
        pendingServerResponsesRef.current.delete(key);
      }
      setServerRequests((current) => current.filter((entry) => requestKey(entry.requestId) !== key));
      return;
    }

    if (message.type === 'server.request.failed') {
      const key = requestKey(message.requestId);
      const pending = pendingServerResponsesRef.current.get(key);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error(message.error.message));
        pendingServerResponsesRef.current.delete(key);
      }
      setLastError(message.error.message);
      return;
    }

    if (message.type === 'event') {
      handleCodexEvent(message.method, message.params as Record<string, unknown>);
      return;
    }

    if (message.type === 'error') {
      setLastError(message.error.message);
    }
  }

  function ingestTurnItems(turnId: string, incoming: ThreadItem[] | undefined): void {
    setItems(current => mergeEmbeddedTurnItems(current, turnId, incoming, viewingHistoryRef.current));
  }

  function handleCodexEvent(method: string, params: Record<string, unknown>): void {
    for (const listener of eventListenersRef.current) listener(method, params);
    const eventThread = params.thread as Thread | undefined;
    const eventThreadId = String(params.threadId ?? eventThread?.id ?? '');
    if (/^(thread|turn|item)\//.test(method)) {
      navigationRevisionRef.current++;
      const turnId = params.turnId ?? (params.turn as { id?: string } | undefined)?.id;
      for (const [key, entry] of navigationCacheRef.current) {
        if (entry.threadId === eventThreadId && (!turnId || entry.turnId === turnId)) navigationCacheRef.current.delete(key);
      }
    }
    if (eventThread?.ephemeral || eventThreadId !== activeThreadRef.current && additionalThreadsRef.current.includes(eventThreadId)) return;
    if (method === 'thread/tokenUsage/updated') {
      const threadId = String(params.threadId ?? '');
      const usage = params.tokenUsage as ContextUsage | undefined;
      if (threadId && usage) setTokenUsage((current) => ({ ...current, [threadId]: usage }));
    }
    if (method === 'remote/connected') {
      scheduleThreadRefresh();
      refreshActiveHistory();
    }
    if (method === 'thread/compacted' && params.threadId === activeThreadRef.current) refreshActiveHistory();
    if (method === 'thread/goal/updated') {
      const threadId = String(params.threadId ?? '');
      if (threadId === activeThreadRef.current) { goalRevisionRef.current++; setActiveGoal(parseThreadGoal(params)); }
    }
    if (method === 'thread/goal/cleared') {
      const threadId = String(params.threadId ?? '');
      if (threadId === activeThreadRef.current) { goalRevisionRef.current++; setActiveGoal(null); }
    }
    if (method === 'thread/started') {
      const thread = params.thread as Thread | undefined;
      if (thread && isTaskThread(thread) && !archivedRef.current) setThreads((current) => dedupeThreads([...current, thread]));
    }

    if (method.startsWith('project/')) {
      void yieldToInteraction().then(refreshProjects).catch(() => undefined);
    }
    if (method === 'thread/unarchived') scheduleThreadRefresh(String(params.threadId ?? ''));

    if (method === 'thread/status/changed') {
      const threadId = String(params.threadId ?? '');
      const status = params.status as Thread['status'] | undefined;
      if (threadId && status) {
        if (!threadsRef.current.some(thread => thread.id === threadId)) scheduleThreadRefresh(threadId);
        setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, status } : thread)));
        setActiveThread((current) => (current?.id === threadId ? { ...current, status } : current));
        if (threadId === activeThreadRef.current && status.type !== 'active') {
          turnRevisionRef.current += 1;
          activeTurnIdRef.current = null;
          setActiveTurnId(null);
        }
      }
    }

    if (method === 'thread/name/updated') {
      const threadId = String(params.threadId ?? '');
      const name = typeof params.threadName === 'string' ? params.threadName : typeof params.name === 'string' ? params.name : null;
      if (threadId) {
        setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, name } : thread)));
        setActiveThread((current) => (current?.id === threadId ? { ...current, name } : current));
      }
    }

    if (method === 'thread/settings/updated') {
      const threadId = String(params.threadId ?? '');
      const settings = params.threadSettings as
        | ({ model?: string; effort?: string | null; collaborationMode?: CollaborationMode } & PermissionSettings)
        | undefined;
      if (threadId && settings) {
        setThreads((current) =>
          current.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  ...(settings.model ? { model: settings.model } : {}),
                  ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
                  ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {}),
                  permissionProfile: permissionProfileId(settings)
                }
              : thread
          )
        );
        setActiveThread((current) =>
          current?.id === threadId
            ? {
                ...current,
                ...(settings.model ? { model: settings.model } : {}),
                ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
                ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {}),
                permissionProfile: permissionProfileId(settings)
              }
            : current
        );
      }
    }

    if (method === 'thread/project/updated') {
      const threadId = String(params.threadId ?? '');
      const projectId =
        typeof params.projectId === 'string' ? params.projectId : null;
      if (threadId) {
        setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, projectId } : thread)));
        setActiveThread((current) => (current?.id === threadId ? { ...current, projectId } : current));
      }
    }

    if (method === 'thread/archived' || method === 'thread/deleted') {
      const threadId = String(params.threadId ?? '');
      if (threadId) {
        historyCacheRef.current.delete(threadId);
        void removeDeviceChat(threadId);
        threadsRef.current = threadsRef.current.filter(thread => thread.id !== threadId);
        setThreads((current) => current.filter((thread) => thread.id !== threadId));
        if (threadId === activeThreadRef.current) closeThread();
      }
    }

    if (method === 'serverRequest/resolved') {
      const requestId = params.requestId as string | number | undefined;
      if (requestId !== undefined) {
        const key = requestKey(requestId);
        setServerRequests((current) => current.filter((entry) => requestKey(entry.requestId) !== key));
      }
    }

    if (method === 'item/started' && params.threadId === activeThreadRef.current) {
      const item = params.item as ThreadItem | undefined;
      if (item?.id) {
        setItems((current) => viewingHistoryRef.current && !current.some(entry =>
          itemKey(entry) === itemKey({ id: item.id, turnId: String(params.turnId ?? '') })) ? current
          : upsertItem(current, { ...item, turnId: String(params.turnId ?? ''),
            startedAtMs: params.startedAtMs as number | null ?? null }));
      }
    }

    if (method === 'turn/started' && params.threadId === activeThreadRef.current) {
      const turn = params.turn as Turn | undefined;
      if (turn?.id) {
        turnRevisionRef.current += 1;
        activeTurnIdRef.current = turn.id;
        setActiveTurnId(turn.id);
        const { items: turnItems, ...timing } = turn;
        setTurnTimings((current) => ({ ...current, [turn.id]: timing }));
        ingestTurnItems(turn.id, turnItems);
      }
    }
    if (method === 'turn/started') scheduleThreadRefresh(String(params.threadId ?? ''));

    if (method === 'item/completed' && params.threadId === activeThreadRef.current) {
      const item = params.item as ThreadItem | undefined;
      if (item?.id) {
        flushStreamingDeltas();
        setItems((current) => viewingHistoryRef.current && !current.some(entry =>
          itemKey(entry) === itemKey({ id: item.id, turnId: String(params.turnId ?? '') })) ? current
          : upsertItem(current, { ...item, turnId: String(params.turnId ?? ''),
            completedAtMs: params.completedAtMs as number | null ?? null }));
      }
    }

    if (method === 'item/agentMessage/delta' && params.threadId === activeThreadRef.current) {
      const itemId = String(params.itemId ?? '');
      const delta = String(params.delta ?? '');
      if (itemId && delta) queueStreamingDelta('agent', itemId, delta, String(params.turnId ?? ''));
    }

    if (method === 'item/commandExecution/outputDelta' && params.threadId === activeThreadRef.current) {
      const itemId = String(params.itemId ?? '');
      const delta = String(params.delta ?? '');
      if (itemId && delta) queueStreamingDelta('command', itemId, delta, String(params.turnId ?? ''));
    }

    if (method === 'turn/completed') {
      const threadId = String(params.threadId ?? '');
      if (threadId === activeThreadRef.current) {
        flushStreamingDeltas();
        const turn = params.turn as Turn | undefined;
        if (turn?.id) {
          const { items: turnItems, ...timing } = turn;
          setTurnTimings((current) => ({ ...current, [turn.id]: timing }));
          ingestTurnItems(turn.id, turnItems);
        }
        turnRevisionRef.current += 1;
        activeTurnIdRef.current = null;
        setActiveTurnId(null);
        refreshActiveHistory();
      }
      scheduleThreadRefresh(threadId);
      if (threadId === activeThreadRef.current) outlineRefreshRef.current?.();
    }
  }

  const status = useMemo(() => {
    if (!authenticated) return 'authenticated' as const;
    if (!connected) return 'disconnected' as const;
    if (bridgeStatus.status === 'ready') return 'ready' as const;
    return bridgeStatus.status;
  }, [authenticated, bridgeStatus.status, connected]);

  return {
    authenticated,
    connected,
    chatTransport,
    status,
    bridgeStatus,
    threads,
    threadsLoading,
    models,
    permissionProfiles,
    defaultPermissionProfile,
    refreshPermissions,
    projects,
    activeThreadId,
    activeTurnId,
    activeThread,
    activeGoal,
    setGoal,
    clearGoal,
    items,
    turnTimings,
    contextUsage: activeThreadId ? tokenUsage[activeThreadId] : undefined,
    hasMoreHistory,
    loadingHistory,
    hasNewerHistory,
    newerHistoryCursor: newerHistoryCursorRef.current,
    viewingHistory,
    loadingLaterHistory,
    revealingHistory,
    outlineTurns,
    outlineError,
    serverRequests,
    questionCounts,
    loadingThread,
    threadReady: threadReady && timedThreadId === activeThreadId && verifiedThreadId === activeThreadId,
    showArchived,
    lastError,
    reconnect,
    refreshThreads,
    refreshProjects,
    openThread,
    loadEarlierHistory,
    prefetchEarlierHistory,
    loadLaterHistory,
    revealHistory,
    cancelHistoryReveal,
    returnToLatest,
    closeThread,
    createThread,
    isNewThread: activeThreadId ? newThreadsRef.current.has(activeThreadId) : false,
    listSkills,
    listModes,
    listMcp,
    compactThread,
    reviewThread,
    forkThread,
    sendTurn,
    setThreadSettings,
    renameThread,
    archiveThread,
    toggleArchived,
    steerTurn,
    interruptTurn,
    respondToRequest,
    setLastError
  };
}

export type RemoteState = ReturnType<typeof useRemote>;

function requestKey(requestId: string | number): string {
  return String(requestId);
}
