import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { HttpError, isAbortedRequest, ReadRequests } from './api';
import { yieldToInteraction } from './background-work';
import { applyTaskPage, provisionalThread, type ThreadListPage } from './loading-snapshots';
import { reconcileThreadList } from './remote-state';
import { dedupeThreads } from './workspace-model';
import { isTaskThread } from '../shared/thread-source';
import { markStartup } from './startup';
import type { ModelInfo, ProjectInfo, Thread, WorkspaceBootstrap } from './types';

interface DirectoryOptions {
  bootstrap: WorkspaceBootstrap | null;
  disposedRef: { current: boolean };
  authExpiredRef: { current: (() => void) | undefined };
  setLastError: Dispatch<SetStateAction<string | null>>;
}

export function useWorkspaceDirectory({ bootstrap, disposedRef, authExpiredRef, setLastError }: DirectoryOptions) {
  const [threads, setThreads] = useState<Thread[]>(() => dedupeThreads((bootstrap?.threads?.data ?? []).filter(isTaskThread)));
  const [threadsLoading, setThreadsLoading] = useState(!bootstrap?.threads);
  const [models, setModels] = useState<ModelInfo[]>(bootstrap?.models?.data ?? []);
  const [projects, setProjects] = useState<ProjectInfo[]>(bootstrap?.projects?.data ?? []);
  const threadsRef = useRef(threads);
  const listRefreshRef = useRef<Promise<Thread[]> | null>(null);
  const listPaginationRef = useRef<AbortController | null>(null);
  const listRetryTimerRef = useRef<number | undefined>(undefined);
  const listFailuresRef = useRef(0);
  const listStartedAtRef = useRef(0);
  const listFirstPagePendingRef = useRef(false);
  const listErrorRef = useRef<string | null>(null);
  const retryThreadsRef = useRef<() => void>(() => {});
  const archivedRef = useRef(false);
  const nativeListSeenRef = useRef(false);
  const nativeProjectsSeenRef = useRef(false);
  const nativeModelsSeenRef = useRef(false);
  const metadataVersionsRef = useRef({ models: 0, projects: 0 });
  const metadataFailuresRef = useRef(new Set<'models' | 'projects'>());
  const metadataErrorsRef = useRef<Partial<Record<'models' | 'projects', string>>>({});
  const retryMetadataRef = useRef<() => void>(() => {});
  const provisionalListRef = useRef(new Map<string, Thread>());
  const listRequestsRef = useRef(new ReadRequests());
  const metadataRequestsRef = useRef(new ReadRequests());
  threadsRef.current = threads;

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

  return { threads, threadsLoading, models, projects, setThreads, setThreadsLoading, setModels, setProjects, threadsRef, listRefreshRef, listPaginationRef, listRetryTimerRef, listFailuresRef, listStartedAtRef, listFirstPagePendingRef, listErrorRef, retryThreadsRef, archivedRef, nativeListSeenRef, nativeProjectsSeenRef, nativeModelsSeenRef, metadataVersionsRef, metadataFailuresRef, metadataErrorsRef, retryMetadataRef, provisionalListRef, listRequestsRef, metadataRequestsRef, refreshThreads, restartTaskRead, refreshMetadata, refreshProjects };
}
