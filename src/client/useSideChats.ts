import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import type { ChatTransport } from './chat-transport';
import type { ChatInput } from './queued-messages';
import { upsertItem, mergeLatestHistoryItems, mergeTurnTimings } from './remote-state';
import type { CollaborationMode, Thread, ThreadItem, Turn } from './types';
import { type TurnTiming } from '../shared/turn-timing';
import { permissionProfileUpdate } from '../shared/permissions';
import { collaborationMode } from './slash-commands';
import { api } from './api';
import { conversationEvent, type ChatViewState } from './conversation-state';
import { isSideConversationThread } from '../shared/thread-source';

export type SideChat = ChatViewState & { desktop?: boolean };
export interface SideChatAdoptionRequest { id: number; chatId: string }

function hasSideConversationBoundary(thread: Thread): boolean {
  return (thread.turns ?? []).some(turn => turn.items.some(item => {
    if (item.type !== 'userMessage') return false;
    return item.content.some(content => content.type === 'text' &&
      typeof content.text === 'string' && content.text.includes('Side conversation boundary.'));
  }));
}

function canProbeDesktopSideChat(thread: Thread): boolean {
  return !thread.parentThreadId && Boolean(thread.forkedFromId) && thread.threadSource !== 'codex_remote';
}

export function desktopSideChatParent(thread: Thread, activeThreadId: string | null): string | null {
  if (thread.parentThreadId) return null;
  const classified = isSideConversationThread(thread);
  const unclassifiedEphemeralFork = thread.ephemeral && Boolean(thread.forkedFromId) &&
    thread.threadSource !== 'codex_remote';
  if (!classified && !unclassifiedEphemeralFork && !hasSideConversationBoundary(thread)) return null;
  return thread.forkedFromId ?? activeThreadId;
}

function timingFromTurn(turn: Turn): TurnTiming {
  const { items: _items, ...timing } = turn;
  return timing;
}

function itemsFromTurns(turns: Turn[]): ThreadItem[] {
  return turns.flatMap(turn => turn.items.map(item => ({ ...item, turnId: turn.id })));
}

function desktopSideChat(thread: Thread, sourceThreadId: string, index: number): SideChat {
  const turns = thread.turns ?? [];
  const activeTurnId = [...turns].reverse().find(turn => turn.status === 'inProgress')?.id ?? null;
  return {
    id: randomUUID(),
    threadId: thread.id,
    sourceThreadId,
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

export function sideChatEvent(chat: SideChat, method: string, params: Record<string, unknown>): SideChat {
  const next = conversationEvent(chat, method, params);
  if (params.threadId === chat.threadId && method === 'thread/closed') return { ...next, activeTurnId: null, unavailable: true, error: '临时聊天已关闭，请新建侧边聊天。' };
  return next;
}

export function useSideChats(transport: ChatTransport, connected: boolean, activeThreadId: string | null) {
  const [chats, setChats] = useState<SideChat[]>([]);
  const [adoptionRequest, setAdoptionRequest] = useState<SideChatAdoptionRequest | null>(null);
  const chatsRef = useRef(chats);
  const sequenceRef = useRef(0);
  const adoptionSequenceRef = useRef(0);
  const eventsRef = useRef<Array<[string, Record<string, unknown>]>>([]);
  const timerRef = useRef<number | null>(null);
  const creatingRef = useRef(new Map<string, Promise<string>>());

  const update = useCallback((fn: (current: SideChat[]) => SideChat[]) => {
    chatsRef.current = fn(chatsRef.current);
    setChats(chatsRef.current);
  }, []);
  const patch = useCallback((id: string, changes: Partial<SideChat>) => {
    update(current => current.map(chat => chat.id === id ? { ...chat, ...changes } : chat));
  }, [update]);
  const watch = useCallback(() => {
    transport.watch(chatsRef.current.flatMap(chat => chat.threadId ? [chat.threadId] : []), 'side-chats');
  }, [transport]);

  const adoptThread = useCallback((thread: Thread, parentThreadId: string): string | null => {
    if (!desktopSideChatParent(thread, parentThreadId)) return null;
    let chatId: string | null = null;
    let created = false;
    update(current => {
      const existing = current.find(chat => chat.threadId === thread.id);
      if (existing) {
        chatId = existing.id;
        return current.map(chat => chat.id === existing.id ? {
          ...chat, title: thread.name?.trim() || chat.title,
          ...(thread.cwd ? { cwd: thread.cwd } : {}), desktop: true, error: null
        } : chat);
      }
      const chat = desktopSideChat(thread, thread.forkedFromId ?? parentThreadId, ++sequenceRef.current);
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

  const mergeThreadSnapshot = useCallback((thread: Thread) => {
    const turns = thread.turns ?? [];
    if (!thread.id || turns.length === 0) return;
    update(current => current.map(chat => chat.threadId !== thread.id ? chat : {
      ...chat,
      title: thread.name?.trim() || chat.title,
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
      items: mergeLatestHistoryItems(itemsFromTurns(turns), chat.items),
      timings: { ...Object.fromEntries(turns.map(turn => [turn.id, timingFromTurn(turn)])), ...chat.timings },
      activeTurnId: [...turns].reverse().find(turn => turn.status === 'inProgress')?.id ?? chat.activeTurnId,
      error: null
    }));
  }, [update]);

  useEffect(() => {
    const retries = new Set<number>();
    const unsubscribe = transport.subscribe((method, params) => {
      if (method === 'thread/started') {
        const thread = params.thread as Thread | undefined;
        const parentThreadId = thread ? desktopSideChatParent(thread, activeThreadId) : null;
        if (thread && parentThreadId) {
          adoptThread(thread, parentThreadId);
          void transport.rpc<{ thread: Thread }>('thread/read', {
            threadId: thread.id, includeTurns: true
          }).then(result => mergeThreadSnapshot(result.thread)).catch(() => undefined);
        }
        if (thread && !parentThreadId && canProbeDesktopSideChat(thread)) {
          for (const delay of [250, 900, 2000]) {
            const timer = window.setTimeout(() => {
              retries.delete(timer);
              void transport.rpc<{ thread: Thread }>('thread/read', {
                threadId: thread.id, includeTurns: true
              }).then(result => {
                const parent = desktopSideChatParent(result.thread, activeThreadId);
                if (!parent) return;
                for (const pending of retries) window.clearTimeout(pending);
                retries.clear();
                adoptThread(result.thread, parent);
                mergeThreadSnapshot(result.thread);
              }).catch(() => undefined);
            }, delay);
            retries.add(timer);
          }
        }
        return;
      }
      if (!chatsRef.current.some(chat => chat.threadId && chat.threadId === params.threadId)) return;
      eventsRef.current.push([method, params]);
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const events = eventsRef.current.splice(0);
        update(current => current.map(chat => events.reduce((state, [name, data]) => sideChatEvent(state, name, data), chat)));
      }, 60);
    });
    return () => {
      unsubscribe();
      transport.watch([], 'side-chats');
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      for (const timer of retries) window.clearTimeout(timer);
    };
  }, [adoptThread, activeThreadId, mergeThreadSnapshot, transport, update]);

  useEffect(() => {
    if (!connected || !activeThreadId) return;
    let disposed = false;
    void (async () => {
      const loaded = await transport.rpc<{ data: string[] }>('thread/loaded/list', { limit: 100 });
      for (const threadId of loaded.data) {
        if (disposed || chatsRef.current.some(chat => chat.threadId === threadId)) continue;
        try {
          const metadata = await transport.rpc<{ thread: Thread }>('thread/read', {
            threadId, includeTurns: false
          });
          if (!desktopSideChatParent(metadata.thread, activeThreadId) &&
              !canProbeDesktopSideChat(metadata.thread)) continue;
          const snapshot = await transport.rpc<{ thread: Thread }>('thread/read', {
            threadId, includeTurns: true
          });
          const parent = desktopSideChatParent(snapshot.thread, activeThreadId);
          if (!disposed && parent) adoptThread(snapshot.thread, parent);
        } catch {
          // A thread can unload between the list and read calls.
        }
      }
    })().catch(() => undefined);
    return () => { disposed = true; };
  }, [activeThreadId, adoptThread, connected, transport]);

  useEffect(() => {
    if (!connected) return;
    watch();
    let disposed = false;
    for (const chat of chatsRef.current) {
      if (!chat.threadId) continue;
      if (chat.desktop) {
        void transport.rpc<{ thread: Thread }>('thread/read', {
          threadId: chat.threadId, includeTurns: true
        }).then(result => { if (!disposed) mergeThreadSnapshot(result.thread); }).catch(() => undefined);
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
  }, [connected, mergeThreadSnapshot, transport, patch, update, watch]);

  function add(options: Pick<SideChat, 'model' | 'effort' | 'permissions'> & Partial<Pick<SideChat, 'cwd' | 'projectId' | 'sourceThreadId' | 'initialInput'>>) {
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
    const clientUserMessageId = randomUUID();
    const submitted = (entry: SideChat, turnId: string): SideChat => ({
      ...entry, items: upsertItem(entry.items, { type: 'userMessage', id: clientUserMessageId, turnId, content: input })
    });
    if (chat.activeTurnId) {
      await transport.rpc('turn/steer', { threadId, expectedTurnId: chat.activeTurnId, input, clientUserMessageId });
      update(current => current.map(entry => entry.id === id ? submitted(entry, chat.activeTurnId!) : entry));
      return;
    }
    const mode: CollaborationMode = collaborationMode(chat.mode, chat.model, chat.effort);
    const result = await transport.rpc<{ turn: TurnTiming & { items?: ThreadItem[] } }>('turn/start', {
      threadId, input, clientUserMessageId, ...(chat.model ? { model: chat.model } : {}), ...(chat.effort ? { effort: chat.effort } : {}),
      ...(chat.permissions ? permissionProfileUpdate(chat.permissions) : {}),
      collaborationMode: mode
    });
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
