import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import type { ChatTransport } from './chat-transport';
import type { ChatInput } from './queued-messages';
import { upsertItem, mergeLatestHistoryItems, mergeTurnTimings, reconcileActiveTurnId } from './remote-state';
import type { CollaborationMode, Thread, ThreadItem, Turn } from './types';
import { type TurnTiming } from '../shared/turn-timing';
import { permissionProfileId, permissionProfileUpdate, type PermissionSettings } from '../shared/permissions';
import { collaborationMode } from './slash-commands';
import { api } from './api';
import { conversationEvent, type ChatViewState } from './conversation-state';
import { isSideConversationThread } from '../shared/thread-source';
import { sideChatAction } from './side-chat-actions';

export type SideChat = ChatViewState & { desktop?: boolean; settingsRevision?: number };
export interface SideChatAdoptionRequest { id: number; chatId: string }
export interface SideChatsController {
  chats: SideChat[];
  adoptionRequest: SideChatAdoptionRequest | null;
  add(options: Pick<SideChat, 'model' | 'effort' | 'permissions'> &
    Partial<Pick<SideChat, 'cwd' | 'projectId' | 'sourceThreadId' | 'initialInput' | 'modelProvider'>>): string;
  patch(id: string, changes: Partial<SideChat>): void;
  send(id: string, input: ChatInput): Promise<void>;
  close(id: string): Promise<boolean>;
}

function hasSideConversationBoundary(thread: Thread): boolean {
  return (thread.turns ?? []).some(turn => turn.items.some(item => {
    if (item.type !== 'userMessage') return false;
    return item.content.some(content => content.type === 'text' &&
      typeof content.text === 'string' && /^Side conversation boundary\.(?:\r?\n|$)/.test(content.text));
  }));
}

function canProbeDesktopSideChat(thread: Thread): boolean {
  return !thread.parentThreadId && !(thread.source && typeof thread.source === 'object' && 'subAgent' in thread.source) &&
    Boolean(thread.forkedFromId) && thread.threadSource !== 'codex_remote';
}

export function isDesktopSideChat(thread: Thread): boolean {
  if (thread.parentThreadId || thread.threadSource === 'codex_remote' ||
      thread.source && typeof thread.source === 'object' && 'subAgent' in thread.source) return false;
  return isSideConversationThread(thread) || Boolean(thread.forkedFromId) && hasSideConversationBoundary(thread);
}

export async function readLoadedThreadIds(transport: Pick<ChatTransport, 'rpc'>, cancelled: () => boolean) {
  const threadIds = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  while (!cancelled()) {
    const page = await transport.rpc<{ data?: string[]; nextCursor?: string | null }>(
      'thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const id of page.data ?? []) if (typeof id === 'string' && id) threadIds.add(id);
    const next = page.nextCursor;
    if (!next || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return [...threadIds];
}

function timingFromTurn(turn: Turn): TurnTiming {
  const { items: _items, ...timing } = turn;
  return timing;
}

function itemsFromTurns(turns: Turn[]): ThreadItem[] {
  return turns.flatMap(turn => turn.items.map(item => ({ ...item, turnId: turn.id })));
}

function desktopSideChat(thread: Thread, index: number): SideChat {
  const turns = thread.turns ?? [];
  const activeTurnId = [...turns].reverse().find(turn => turn.status === 'inProgress')?.id ?? null;
  return {
    id: randomUUID(),
    threadId: thread.id,
    ...(thread.forkedFromId ? { sourceThreadId: thread.forkedFromId } : {}),
    title: thread.name?.trim() || (index === 1 ? '桌面侧边聊天' : `桌面侧边聊天 ${index}`),
    cwd: thread.cwd,
    model: thread.model ?? '',
    effort: thread.reasoningEffort ?? '',
    permissions: thread.permissionProfile ?? '',
    mode: thread.collaborationMode?.mode ?? 'default',
    items: itemsFromTurns(turns),
    timings: Object.fromEntries(turns.map(turn => [turn.id, timingFromTurn(turn)])),
    activeTurnId,
    desktop: true,
    error: null
  };
}

export function mergeDesktopSideChatSnapshot(chat: SideChat, thread: Thread, baseline: SideChat): SideChat {
  const turns = (thread.turns ?? []).map(timingFromTurn);
  const timings = mergeTurnTimings(chat.timings, turns, baseline.timings);
  const mergedTurns = Object.values(timings);
  const activeTurnId = [...mergedTurns].reverse().find(turn => turn.status === 'inProgress')?.id ?? null;
  const unchangedSettings = chat.settingsRevision === baseline.settingsRevision;
  return {
    ...chat,
    title: thread.name?.trim() || chat.title,
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    ...(thread.forkedFromId ? { sourceThreadId: thread.forkedFromId } : {}),
    ...(unchangedSettings && thread.model != null && chat.model === baseline.model ? { model: thread.model } : {}),
    ...(unchangedSettings && thread.reasoningEffort != null && chat.effort === baseline.effort ? { effort: thread.reasoningEffort } : {}),
    ...(unchangedSettings && thread.permissionProfile != null && chat.permissions === baseline.permissions ? { permissions: thread.permissionProfile } : {}),
    ...(unchangedSettings && thread.collaborationMode && chat.mode === baseline.mode ? { mode: thread.collaborationMode.mode } : {}),
    items: mergeLatestHistoryItems(chat.items, itemsFromTurns(thread.turns ?? []), baseline.items),
    timings,
    activeTurnId: reconcileActiveTurnId(chat.activeTurnId, timings, { activeTurnId, turns: mergedTurns }),
    error: null
  };
}

export function sideChatEvent(chat: SideChat, method: string, params: Record<string, unknown>): SideChat {
  const next = conversationEvent(chat, method, params);
  if (chat.desktop && params.threadId === chat.threadId && method === 'thread/settings/updated') {
    const settings = params.threadSettings as (PermissionSettings & {
      model?: string; effort?: string | null; collaborationMode?: CollaborationMode
    }) | undefined;
    if (!settings) return next;
    const permissions = permissionProfileId(settings);
    return { ...next, settingsRevision: (chat.settingsRevision ?? 0) + 1,
      ...(settings.model != null ? { model: settings.model } : {}),
      ...(settings.effort !== undefined ? { effort: settings.effort ?? '' } : {}),
      ...(settings.collaborationMode ? { mode: settings.collaborationMode.mode } : {}),
      ...(permissions != null ? { permissions } : {}) };
  }
  if (params.threadId === chat.threadId && method === 'thread/closed') return { ...next, activeTurnId: null, unavailable: true, error: '临时聊天已关闭，请新建侧边聊天。' };
  return next;
}

export function useSideChats(transport: ChatTransport, connected: boolean): SideChatsController {
  const [chats, setChats] = useState<SideChat[]>([]);
  const [adoptionRequest, setAdoptionRequest] = useState<SideChatAdoptionRequest | null>(null);
  const chatsRef = useRef(chats);
  const sequenceRef = useRef(0);
  const adoptionSequenceRef = useRef(0);
  const eventsRef = useRef<Array<[string, Record<string, unknown>]>>([]);
  const timerRef = useRef<number | null>(null);
  const creatingRef = useRef(new Map<string, Promise<string>>());
  const closedDesktopRef = useRef(new Set<string>());
  const readsRef = useRef(new Map<string, Promise<{ thread: Thread; baseline: SideChat | undefined }>>());

  const update = useCallback((fn: (current: SideChat[]) => SideChat[]) => {
    chatsRef.current = fn(chatsRef.current);
    setChats(chatsRef.current);
  }, []);
  const patch = useCallback((id: string, changes: Partial<SideChat>) => {
    const settingsChanged = ['model', 'effort', 'permissions', 'mode'].some(key => key in changes);
    update(current => current.map(chat => chat.id === id ? { ...chat, ...changes,
      ...(chat.desktop && settingsChanged ? { settingsRevision: (chat.settingsRevision ?? 0) + 1 } : {}) } : chat));
  }, [update]);
  const flushEvents = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const events = eventsRef.current.splice(0);
    if (events.length) update(current => current.map(chat =>
      events.reduce((state, [name, data]) => sideChatEvent(state, name, data), chat)));
  }, [update]);
  const watch = useCallback(() => {
    transport.watch(chatsRef.current.flatMap(chat => chat.threadId ? [chat.threadId] : []), 'side-chats');
  }, [transport]);

  const adoptThread = useCallback((thread: Thread, baseline?: SideChat): string | null => {
    if (!isDesktopSideChat(thread) || closedDesktopRef.current.has(thread.id)) return null;
    let chatId: string | null = null;
    let created = false;
    update(current => {
      const existing = current.find(chat => chat.threadId === thread.id);
      if (existing) {
        chatId = existing.id;
        return current.map(chat => chat.id === existing.id
          ? mergeDesktopSideChatSnapshot(chat, thread, baseline ?? { ...chat, items: [], timings: {} }) : chat);
      }
      const chat = desktopSideChat(thread, ++sequenceRef.current);
      chatId = chat.id;
      created = true;
      return [...current, chat];
    });
    watch();
    if (created && chatId) {
      setAdoptionRequest({ id: ++adoptionSequenceRef.current, chatId });
    }
    return chatId;
  }, [update, watch]);

  const readSnapshot = useCallback((threadId: string) => {
    const pending = readsRef.current.get(threadId);
    if (pending) return pending;
    flushEvents();
    const baseline = chatsRef.current.find(chat => chat.threadId === threadId);
    const read = transport.rpc<{ thread: Thread }>('thread/read', { threadId, includeTurns: true })
      .then(result => {
        // Project queued deltas before reconciling a snapshot that may contain them.
        flushEvents();
        return { thread: result.thread, baseline };
      })
      .finally(() => { if (readsRef.current.get(threadId) === read) readsRef.current.delete(threadId); });
    readsRef.current.set(threadId, read);
    return read;
  }, [flushEvents, transport]);

  useEffect(() => {
    let disposed = false;
    const retries = new Map<string, Set<number>>();
    const cancelRetries = (threadId: string) => {
      for (const timer of retries.get(threadId) ?? []) window.clearTimeout(timer);
      retries.delete(threadId);
    };
    const refresh = (threadId: string) => readSnapshot(threadId).then(({ thread, baseline }) => {
      if (disposed || closedDesktopRef.current.has(threadId) || !isDesktopSideChat(thread)) return;
      cancelRetries(threadId);
      adoptThread(thread, baseline);
    }).catch(() => undefined);
    watch();
    const unsubscribe = transport.subscribe((method, params) => {
      if (method === 'thread/started') {
        const thread = params.thread as Thread | undefined;
        if (!thread || closedDesktopRef.current.has(thread.id)) return;
        if (isDesktopSideChat(thread)) {
          if (!chatsRef.current.some(chat => chat.threadId === thread.id)) adoptThread(thread);
          void refresh(thread.id);
        } else if (canProbeDesktopSideChat(thread) && !retries.has(thread.id)) {
          const timers = new Set<number>();
          retries.set(thread.id, timers);
          for (const delay of [250, 900, 2000]) {
            const timer = window.setTimeout(() => {
              timers.delete(timer);
              void refresh(thread.id);
            }, delay);
            timers.add(timer);
          }
        }
        return;
      }
      if (!chatsRef.current.some(chat => chat.threadId && chat.threadId === params.threadId)) return;
      eventsRef.current.push([method, params]);
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(flushEvents, 60);
    });
    return () => {
      disposed = true;
      unsubscribe();
      transport.watch([], 'side-chats');
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      eventsRef.current = [];
      for (const threadId of retries.keys()) cancelRetries(threadId);
    };
  }, [adoptThread, flushEvents, readSnapshot, transport, watch]);

  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    void (async () => {
      const threadIds = await readLoadedThreadIds(transport, () => disposed);
      for (const threadId of threadIds) {
        if (disposed) break;
        if (closedDesktopRef.current.has(threadId) || chatsRef.current.some(chat => chat.threadId === threadId)) continue;
        try {
          const metadata = await transport.rpc<{ thread: Thread }>('thread/read', {
            threadId, includeTurns: false
          });
          if (disposed || !isDesktopSideChat(metadata.thread) && !canProbeDesktopSideChat(metadata.thread)) continue;
          const { thread, baseline } = await readSnapshot(threadId);
          if (!disposed) adoptThread(thread, baseline);
        } catch {
          // A thread can unload between the list and read calls.
        }
      }
    })().catch(() => undefined);
    return () => { disposed = true; };
  }, [adoptThread, connected, readSnapshot, transport]);

  useEffect(() => {
    if (!connected) return;
    watch();
    let disposed = false;
    for (const chat of chatsRef.current) {
      if (!chat.threadId) continue;
      if (chat.desktop) {
        void readSnapshot(chat.threadId).then(({ thread, baseline }) => {
          if (!disposed && !closedDesktopRef.current.has(thread.id)) adoptThread(thread, baseline);
        }).catch(() => undefined);
        continue;
      }
      const baseline = chat.items;
      const timingBaseline = chat.timings;
      void api<{ items: ThreadItem[]; turns: TurnTiming[]; activeTurnId: string | null }>(
        `/api/side-chat?${new URLSearchParams({ threadId: chat.threadId })}`, { cache: 'no-store' }).then(snapshot => {
          if (disposed) return;
          update(current => current.map(entry => entry.id !== chat.id ? entry : {
            ...entry,
            items: mergeLatestHistoryItems(entry.items, snapshot.items, baseline),
            timings: mergeTurnTimings(entry.timings, snapshot.turns, timingBaseline),
            ...(entry.timings === timingBaseline ? { activeTurnId: snapshot.activeTurnId } : {})
          }));
        }).catch(error => { if (!disposed) patch(chat.id, { unavailable: true, activeTurnId: null,
          error: `无法恢复临时聊天：${error instanceof Error ? error.message : String(error)}` }); });
    }
    return () => { disposed = true; };
  }, [adoptThread, connected, readSnapshot, transport, patch, update, watch]);

  function add(options: Pick<SideChat, 'model' | 'effort' | 'permissions'> &
    Partial<Pick<SideChat, 'modelProvider' | 'cwd' | 'projectId' | 'sourceThreadId' | 'initialInput'>>) {
    const index = ++sequenceRef.current;
    const id = randomUUID();
    update(current => [...current, { ...options, id, title: index === 1 ? '侧边聊天' : `侧边聊天 ${index}`,
      mode: 'default', items: [], timings: {}, activeTurnId: null, error: null }]);
    return id;
  }

  async function ensureThread(id: string) {
    const chat = chatsRef.current.find(entry => entry.id === id);
    if (!chat || chat.closing || chat.unavailable) throw new Error('侧边聊天不可用。');
    if (chat.threadId) return chat.threadId;
    const existing = creatingRef.current.get(id);
    if (existing) return existing;
    const creation = (async () => {
      const result = await transport.rpc<{ thread: Thread; model?: string }>(
        chat.sourceThreadId ? 'thread/fork' : 'thread/start', {
          ...(chat.sourceThreadId ? { threadId: chat.sourceThreadId, excludeTurns: true } : {}),
          threadSource: 'codex_remote',
          ephemeral: true, ...(chat.cwd ? { cwd: chat.cwd } : {}),
          ...(chat.projectId ? { projectId: chat.projectId } : {}),
          ...(chat.model ? { model: chat.model } : {}),
          ...(chat.effort ? { config: { model_reasoning_effort: chat.effort } } : {}),
          ...(chat.permissions ? permissionProfileUpdate(chat.permissions) : {})
        });
      update(current => current.map(entry => entry.id === id ? {
        ...entry, threadId: result.thread.id, model: entry.model || result.model || result.thread.model || ''
      } : entry));
      watch();
      return result.thread.id;
    })().finally(() => creatingRef.current.delete(id));
    creatingRef.current.set(id, creation);
    return creation;
  }

  async function send(id: string, input: ChatInput) {
    const threadId = await ensureThread(id);
    const chat = chatsRef.current.find(entry => entry.id === id);
    if (!chat || chat.closing || chat.unavailable) return;
    patch(id, { error: null });
    const mode: CollaborationMode = collaborationMode(chat.mode, chat.model, chat.effort);
    const action = sideChatAction(threadId, input, chat.activeTurnId, {
      ...(chat.model ? { model: chat.model } : {}), ...(chat.effort ? { effort: chat.effort } : {}),
      ...(chat.permissions ? permissionProfileUpdate(chat.permissions) : {}),
      collaborationMode: mode
    });
    const clientUserMessageId = action.params.clientUserMessageId;
    const submitted = (entry: SideChat, turnId: string): SideChat => ({
      ...entry, items: upsertItem(entry.items, { type: 'userMessage', id: clientUserMessageId, turnId, content: input })
    });
    let result: { turn: TurnTiming & { items?: ThreadItem[] } };
    try {
      if (action.method === 'turn/steer') {
        await transport.rpc(action.method, action.params);
        action.complete();
        update(current => current.map(entry => entry.id === id ? submitted(entry, action.expectedTurnId!) : entry));
        return;
      }
      result = await transport.rpc(action.method, action.params);
      action.complete();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') action.complete();
      throw error;
    }
    update(current => current.map(entry => {
      if (entry.id !== id) return entry;
      const next = submitted(entry, result.turn.id);
      if (entry.timings[result.turn.id]) return next;
      return sideChatEvent(next, 'turn/started', { threadId, turn: result.turn });
    }));
  }

  async function close(id: string) {
    patch(id, { closing: true });
    try {
      await creatingRef.current.get(id);
      const chat = chatsRef.current.find(entry => entry.id === id);
      if (chat?.threadId && chat.desktop) closedDesktopRef.current.add(chat.threadId);
      if (chat?.threadId && !chat.desktop) {
        if (chat.activeTurnId) await transport.rpc('turn/interrupt', { threadId: chat.threadId, turnId: chat.activeTurnId });
        await transport.rpc('thread/unsubscribe', { threadId: chat.threadId });
      }
      update(current => current.filter(entry => entry.id !== id));
      watch();
      return true;
    } catch (error) {
      patch(id, { closing: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  return { chats, adoptionRequest, add, patch, send, close };
}
