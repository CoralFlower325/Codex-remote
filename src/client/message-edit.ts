import type { ChatTransport } from './chat-transport';
import type { ThreadItem } from './types';
import type { TurnTiming } from '../shared/turn-timing';
import { userMessageText } from '../shared/user-message';

export type UserMessage = Extract<ThreadItem, { type: 'userMessage' }>;

export function messageEditText(item: UserMessage): string {
  return item.content.filter(part => part.type === 'text')
    .map(part => userMessageText(part.text ?? '')).filter(Boolean).join('\n\n');
}

export function editableInterruptedMessage(items: ThreadItem[], timings: Record<string, TurnTiming>,
  activeTurnId: string | null): UserMessage | null {
  if (activeTurnId) return null;
  const turnId = items.at(-1)?.turnId;
  if (!turnId || timings[turnId]?.status !== 'interrupted') return null;
  return items.find((item): item is UserMessage => item.type === 'userMessage' && item.turnId === turnId) ?? null;
}

export function editedMessageInput(item: UserMessage, text: string) {
  const inputs = item.content.filter(part => part.type !== 'text');
  const original = item.content.find(part => part.type === 'text')?.text ?? '';
  const boundary = /^\s*# (?:Files|Applications) mentioned by the user:[ \t]*\r?\n/.test(original)
    ? /^## My request:[ \t]*\r?\n/m.exec(original) : null;
  const prefix = boundary ? original.slice(0, boundary.index + boundary[0].length) : '';
  return [...(text.trim() || prefix ? [{ type: 'text', text: prefix + text.trim(), text_elements: [] }] : []), ...inputs];
}

export class MessageEditError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}

/** The history mutation and new turn are each sent once, after fresh native reads. */
export async function replaceInterruptedMessage(rpc: ChatTransport['rpc'], threadId: string, item: UserMessage,
  text: string, settings: Record<string, unknown>, current: () => boolean, onReverted: () => void) {
  await rpc('thread/resume', { threadId, excludeTurns: true });
  const latest = await rpc<{ data: TurnTiming[] }>('thread/turns/list',
    { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  if (latest.data[0]?.id !== item.turnId || latest.data[0]?.status !== 'interrupted') {
    throw new MessageEditError('会话已发生变化。仅能编辑最新被停止轮次的原始消息，请重新核对会话。');
  }
  const first = await rpc<{ data: Array<{ item: ThreadItem }> }>('thread/items/list',
    { threadId, turnId: item.turnId, limit: 1, sortDirection: 'asc' });
  const original = first.data[0]?.item;
  if (!current() || original?.type !== 'userMessage' || original.id !== item.id ||
    JSON.stringify(original.content) !== JSON.stringify(item.content)) {
    throw new MessageEditError('原始消息或当前会话已改变，请重新打开编辑。');
  }
  const input = editedMessageInput(original, text);
  if (!input.length) throw new MessageEditError('请输入消息，或保留至少一个附件或技能。');
  try {
    await rpc('thread/revert', { threadId, beforeTurnId: item.turnId });
    onReverted();
    if (!current()) throw new Error('当前会话已切换，未重新发送。');
    return await rpc<{ turn: TurnTiming }>('turn/start', { ...settings, threadId, input });
  } catch (error) {
    throw new MessageEditError(`${error instanceof Error ? error.message : String(error)}\n` +
      '操作结果尚未确认，请核对会话后再操作。修改内容仍保留在此窗口，不会自动重发。', true);
  }
}
