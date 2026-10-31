import type { ChatInput } from './queued-messages';
import type { ContextUsage, ThreadItem } from './types';
import { upsertItem } from './remote-state';
import { projectTurnTiming, runtimeTurnError, type TurnTiming } from '../shared/turn-timing';

export interface ChatViewState {
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

export function conversationEvent<T extends ChatViewState>(chat: T, method: string, params: Record<string, unknown>): T {
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
  return chat;
}

