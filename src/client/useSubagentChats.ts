import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isAbortedRequest } from './api';
import type { ChatTransport } from './chat-transport';
import { mergeLatestHistoryItems, mergeOlderHistoryItems, mergeOlderTurnTimings, mergeTurnTimings } from './remote-state';
import { subagentSource, type Subagent } from './subagents';
import type { Thread, ThreadHistoryPage } from './types';
import { conversationEvent, type ChatViewState } from './conversation-state';
import { HistoryPrefetch, prepareHistoryPage } from './history-prefetch';
import type { BeforeHistoryCommit } from './history-scroll';

export interface SubagentChat extends ChatViewState {
  agent: Subagent;
  thread?: Thread;
  loading: boolean;
  loadingHistory: boolean;
  cursor: string | null;
  turnsCursor: string | null;
}

function historyItems(page: ThreadHistoryPage) {
  return page.items.map(entry => ({ ...entry.item, turnId: entry.turnId,
    startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs }));
}

export function useSubagentChats(transport: ChatTransport, connected: boolean, parentId?: string) {
  const [chats, setChats] = useState<SubagentChat[]>([]);
  const [directory, setDirectory] = useState<Thread[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const ref = useRef(chats);
  const requests = useRef(new Map<string, AbortController>());
  const earlierPages = useRef(new Map<string, HistoryPrefetch>());
  const events = useRef<Array<[string, Record<string, unknown>]>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((fn: (current: SubagentChat[]) => SubagentChat[]) => {
    ref.current = fn(ref.current); setChats(ref.current);
  }, []);
  const patch = useCallback((id: string, fn: (chat: SubagentChat) => SubagentChat) => {
    update(current => current.map(chat => chat.id === id ? fn(chat) : chat));
  }, [update]);
  const watch = useCallback(() => {
    transport.watch(ref.current.map(chat => chat.id), 'subagents');
  }, [transport]);
  const prepareEarlier = useCallback((id: string) => {
    const chat = ref.current.find(entry => entry.id === id);
    if (!chat?.cursor) return null;
    let buffer = earlierPages.current.get(id);
    if (!buffer) { buffer = new HistoryPrefetch(); earlierPages.current.set(id, buffer); }
    return buffer.read(chat.cursor, signal => prepareHistoryPage(
      () => api<ThreadHistoryPage>(`/api/thread/history?${new URLSearchParams({
        threadId: id, before: chat.cursor!, limit: '100', conversation: '1'
      })}`, { cache: 'no-store', signal, timeoutMs: 15000 }),
      async cursor => {
        const page = await api<Pick<ThreadHistoryPage, 'turns' | 'turnsCursor'>>(
          `/api/thread/timings?${new URLSearchParams({ threadId: id, cursor })}`,
          { cache: 'no-store', signal, timeoutMs: 15000 });
        return { data: page.turns, nextCursor: page.turnsCursor };
      },
      chat.timings, chat.turnsCursor, signal
    ));
  }, []);
  const prefetch = useCallback(async (id: string) => {
    try { await prepareEarlier(id); } catch { /* Foreground paging can retry. */ }
  }, [prepareEarlier]);
  const load = useCallback(async (id: string, earlier = false, beforeCommit?: BeforeHistoryCommit) => {
    const chat = ref.current.find(entry => entry.id === id);
    if (!chat || (earlier && (!chat.cursor || chat.loadingHistory))) return;
    requests.current.get(id)?.abort();
    const controller = new AbortController();
    requests.current.set(id, controller);
    if (!earlier) earlierPages.current.get(id)?.clear();
    const baseline = chat.items;
    const timingBaseline = chat.timings;
    patch(id, entry => ({ ...entry, error: null, ...(earlier ? { loadingHistory: true } : { loading: !entry.items.length }) }));
    try {
      const query = new URLSearchParams({ threadId: id,
        ...(earlier ? { before: chat.cursor!, limit: '100' } : { mode: 'read' }) });
      const page: (ThreadHistoryPage & { result?: { thread: Thread } }) | null = earlier ? await prepareEarlier(id)
        : await api(`/api/thread/open?${query}`, { cache: 'no-store', signal: controller.signal });
      if (earlier && beforeCommit && !await beforeCommit()) {
        if (!controller.signal.aborted) patch(id, entry => ({ ...entry, loadingHistory: false }));
        return;
      }
      if (controller.signal.aborted || !page) return;
      if (earlier) earlierPages.current.get(id)?.clear();
      patch(id, entry => ({ ...entry, loading: false, loadingHistory: false,
        ...(page.result ? { thread: page.result.thread, cwd: page.result.thread.cwd } : {}),
        items: earlier ? mergeOlderHistoryItems(historyItems(page), entry.items)
          : mergeLatestHistoryItems(entry.items, historyItems(page), baseline),
        timings: earlier ? mergeOlderTurnTimings(entry.timings, page.turns)
          : mergeTurnTimings(entry.timings, page.turns, timingBaseline),
        ...(!earlier && entry.timings === timingBaseline ? { activeTurnId: page.activeTurnId } : {}),
        cursor: page.nextCursor, turnsCursor: page.turnsCursor }));
      if (!earlier && (page.activeTurnId || page.result?.thread.status.type === 'active') && !controller.signal.aborted) {
        await transport.rpc('thread/resume', { threadId: id, excludeTurns: true });
      }
    } catch (error) {
      if (!isAbortedRequest(error)) patch(id, entry => ({ ...entry, loading: false, loadingHistory: false,
        error: error instanceof Error ? error.message : String(error) }));
    } finally { if (requests.current.get(id) === controller) requests.current.delete(id); }
  }, [patch, transport, prepareEarlier]);
  useEffect(() => { setDirectory([]); setDirectoryError(null); }, [parentId]);
  useEffect(() => {
    if (!connected || !parentId) { setDirectoryLoading(false); return; }
    let disposed = false;
    const baseline = new Map(directory.map(thread => [thread.id, thread]));
    setDirectoryError(null);
    setDirectoryLoading(true);
    void (async () => {
      try {
        for (const archived of [false, true]) {
          let cursor: string | null = null;
          do {
            const page: { data: Thread[]; nextCursor: string | null } = await transport.rpc('thread/list', {
              parentThreadId: parentId, sourceKinds: ['subAgentThreadSpawn'], modelProviders: [],
              useStateDbOnly: true, limit: 100, archived, ...(cursor ? { cursor } : {})
            });
            if (disposed) return;
            setDirectory(current => {
              const next = new Map(current.map(thread => [thread.id, thread]));
              for (const thread of page.data) {
                if (!next.has(thread.id) || next.get(thread.id) === baseline.get(thread.id)) next.set(thread.id, { ...thread, archived });
              }
              return [...next.values()];
            });
            cursor = page.nextCursor;
          } while (cursor);
        }
      } catch (error) {
        if (!disposed) setDirectoryError(error instanceof Error ? error.message : String(error));
      } finally { if (!disposed) setDirectoryLoading(false); }
    })();
    return () => { disposed = true; };
  }, [parentId, connected, transport]);
  useEffect(() => transport.subscribe((method, params) => {
    if (method === 'thread/started') {
      const thread = params.thread as Thread | undefined;
      if (thread && subagentSource(thread)?.parent_thread_id === parentId) {
        setDirectory(current => current.some(entry => entry.id === thread.id) ? current : [...current, thread]);
      }
    }
    if (method === 'thread/status/changed') setDirectory(current => current.map(thread =>
      thread.id === params.threadId ? { ...thread, status: params.status as Thread['status'] } : thread));
  }), [transport, parentId]);
  useEffect(() => {
    const unsubscribe = transport.subscribe((method, params) => {
      if (!ref.current.some(chat => chat.id === params.threadId)) return;
      events.current.push([method, params]);
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const pending = events.current.splice(0);
        update(current => current.map(chat => pending.reduce((entry, [name, data]) => {
          if (data.threadId !== entry.id) return entry;
          if (name === 'thread/status/changed' && entry.thread) return {
            ...entry, thread: { ...entry.thread, status: data.status as Thread['status'] }
          };
          if (name === 'thread/closed') return { ...entry, activeTurnId: null,
            ...(entry.thread ? { thread: { ...entry.thread, status: { type: 'idle' as const } } } : {}),
            agent: { ...entry.agent, status: 'shutdown' as const } };
          const next = conversationEvent(entry, name, data);
          const turnEvent = name === 'turn/started' || name === 'turn/completed';
          const turnStatus = (data.turn as { status?: string } | undefined)?.status;
          return { ...entry, ...next, ...(turnEvent ? {
            agent: { ...entry.agent, status: name === 'turn/started' ? 'running' as const
              : turnStatus === 'failed' ? 'errored' as const : turnStatus === 'interrupted' ? 'interrupted' as const : 'completed' as const },
            ...(entry.thread ? { thread: { ...entry.thread,
              status: { type: name === 'turn/started' ? 'active' as const : 'idle' as const } } } : {})
          } : {}) };
        }, chat)));
      }, 60);
    });
    return () => {
      unsubscribe(); transport.watch([], 'subagents');
      requests.current.forEach(controller => controller.abort());
      earlierPages.current.forEach(buffer => buffer.clear());
      earlierPages.current.clear();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [transport, update]);
  useEffect(() => {
    if (!connected) return;
    watch();
    ref.current.forEach(chat => { void load(chat.id); });
  }, [connected, load, watch]);

  const open = useCallback((agent: Subagent) => {
    const existing = ref.current.find(chat => chat.id === agent.threadId);
    if (!existing) {
      update(current => [...current, {
        id: agent.threadId, threadId: agent.threadId, title: agent.name, agent,
        model: agent.model ?? '', effort: agent.effort ?? '', permissions: '', mode: 'default',
        items: [], timings: {}, activeTurnId: null, error: null, loading: true,
        loadingHistory: false, cursor: null, turnsCursor: null
      }]);
      watch();
    }
    if (!existing || !requests.current.has(agent.threadId)) void load(agent.threadId);
  }, [load, update, watch]);
  const close = useCallback((id: string) => {
    requests.current.get(id)?.abort(); requests.current.delete(id);
    earlierPages.current.get(id)?.clear(); earlierPages.current.delete(id);
    update(current => current.filter(chat => chat.id !== id));
    watch();
  }, [update, watch]);
  return { chats, directory, directoryLoading, directoryError, open, close, load, prefetch };
}
