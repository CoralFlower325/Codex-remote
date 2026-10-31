import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import type { ChatTransport } from './chat-transport';
import type { ChatInput } from './queued-messages';
import { upsertItem, mergeLatestHistoryItems, mergeTurnTimings } from './remote-state';
import type { CollaborationMode, ContextUsage, Thread, ThreadItem } from './types';
import { projectTurnTiming, runtimeTurnError, type TurnTiming } from '../shared/turn-timing';
import { permissionProfileUpdate } from '../shared/permissions';
import { collaborationMode } from './slash-commands';
import { api } from './api';

export interface SideChat {
  id: string;
  title: string;
  cwd?: string;
  projectId?: string;
  sourceThreadId?: string;
  threadId?: string;
  model: string;
  effort: string;
  permissions: string;
  mode: 'default' | 'plan';
  initialInput?: ChatInput;
  items: ThreadItem[];
  timings: Record<string, TurnTiming>;
  activeTurnId: string | null;
  contextUsage?: ContextUsage;
  error: string | null;
  unavailable?: boolean;
  closing?: boolean;
}

export function sideChatEvent(chat: SideChat, method: string, params: Record<string, unknown>): SideChat {
  if (params.threadId !== chat.threadId) return chat;
  const timings = runtimeTurnError(chat.timings, method, params);
  if (timings !== chat.timings) chat = { ...chat, timings };
  const turnId = String(params.turnId ?? '');
  if (method === 'turn/started' || method === 'turn/completed') {
    const { items: turnItems = [], ...turn } = params.turn as TurnTiming & { items?: ThreadItem[] };
    return { ...chat, activeTurnId: method === 'turn/started' ? turn.id : null,
      items: turnItems.reduce((items, item) => upsertItem(items, { ...item, turnId: turn.id }), chat.items),
      timings: { ...chat.timings, [turn.id]: projectTurnTiming(turn) } };
  }
  if (method === 'item/started' || method === 'item/completed') {
    return { ...chat, items: upsertItem(chat.items, { ...params.item as ThreadItem, turnId,
      ...(method === 'item/started' ? { startedAtMs: params.startedAtMs as number | null ?? null }
        : { completedAtMs: params.completedAtMs as number | null ?? null }) }) };
  }
  if (method === 'item/agentMessage/delta') {
    return { ...chat, items: upsertItem(chat.items, {
      type: 'agentMessage', id: String(params.itemId), turnId, text: String(params.delta)
    }, true) };
  }
  if (method === 'item/commandExecution/outputDelta') {
    return { ...chat, items: chat.items.map(item => item.type === 'commandExecution' &&
      item.id === params.itemId && item.turnId === turnId
      ? { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${String(params.delta)}` } : item) };
  }
  if (method === 'thread/tokenUsage/updated') return { ...chat, contextUsage: params.tokenUsage as ContextUsage };
  if (method === 'thread/closed') return { ...chat, activeTurnId: null, unavailable: true, error: '临时聊天已关闭，请新建侧边聊天。' };
  return chat;
}

export function useSideChats(transport: ChatTransport, connected: boolean) {
  const [chats, setChats] = useState<SideChat[]>([]);
  const chatsRef = useRef(chats);
  const sequenceRef = useRef(0);
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

  useEffect(() => {
    const unsubscribe = transport.subscribe((method, params) => {
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
    };
  }, [transport, update]);

  useEffect(() => {
    if (!connected) return;
    watch();
    let disposed = false;
    for (const chat of chatsRef.current) {
      if (!chat.threadId) continue;
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
  }, [connected, transport, patch, update, watch]);

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
      if (chat?.threadId) {
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

  return { chats, add, patch, send, close };
}
