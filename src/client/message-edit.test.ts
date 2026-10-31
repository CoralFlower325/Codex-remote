import { describe, expect, it, vi } from 'vitest';
import type { ChatTransport } from './chat-transport';
import type { ThreadItem } from './types';
import { editableInterruptedMessage, editedMessageInput, messageEditText, MessageEditError, replaceInterruptedMessage,
  type UserMessage } from './message-edit';
import type { TurnTiming } from '../shared/turn-timing';

const item: UserMessage = { type: 'userMessage', id: 'user', turnId: 'stopped',
  content: [{ type: 'text', text: 'Original' }, { type: 'localImage', path: '/private/image.png' },
    { type: 'skill', path: '/project/SKILL.md' }] };
const stopped: TurnTiming = { id: 'stopped', status: 'interrupted', startedAt: 1, completedAt: 2, durationMs: 1000 };
function fixture() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') return { data: [stopped] };
    if (method === 'thread/items/list') return { data: [{ item }] };
    if (method === 'turn/start') return { turn: { ...stopped, id: 'new', status: 'inProgress' } };
    return {};
  });
  return { calls, rpc, request: rpc as ChatTransport['rpc'] };
}

describe('editing interrupted input', () => {
  it('offers the original user message only for the latest interrupted turn', () => {
    const trace = { type: 'agentMessage', id: 'answer', turnId: 'stopped', text: 'partial' } as ThreadItem;
    expect(editableInterruptedMessage([item, trace], { stopped }, null)).toBe(item);
    expect(editableInterruptedMessage([item], { stopped }, 'running')).toBeNull();
    expect(editableInterruptedMessage([item], { stopped: { ...stopped, status: 'completed' } }, null)).toBeNull();
    expect(editableInterruptedMessage([item, { ...trace, turnId: 'later' }], { stopped }, null)).toBeNull();
  });
  it('preserves attachments, skills and hidden native context when replacing editable prose', () => {
    const prefix = '# Files mentioned by the user:\nimage.png\n\n## My request:\n';
    const wrapped = { ...item, content: [{ type: 'text', text: prefix + 'Original' }, ...item.content.slice(1)] };
    expect(messageEditText(wrapped)).toBe('Original');
    expect(editedMessageInput(wrapped, 'Updated')).toEqual([
      { type: 'text', text: prefix + 'Updated', text_elements: [] }, ...item.content.slice(1)
    ]);
    expect(editedMessageInput(item, '')).toEqual(item.content.slice(1));
  });
  it('checks fresh native state before reverting once, then sends the preserved input once', async () => {
    const { calls, request } = fixture();
    const reverted = vi.fn();
    await replaceInterruptedMessage(request, 'thread', item, 'Updated', { model: 'model' }, () => true, reverted);
    expect(calls.map(call => call.method)).toEqual([
      'thread/resume', 'thread/turns/list', 'thread/items/list', 'thread/revert', 'turn/start'
    ]);
    expect(calls[3]?.params).toEqual({ threadId: 'thread', beforeTurnId: 'stopped' });
    expect(calls[4]?.params).toEqual({ threadId: 'thread', model: 'model', input: editedMessageInput(item, 'Updated') });
    expect(reverted).toHaveBeenCalledOnce();
  });
  it('blocks changed, running or replaced native turns before mutating anything', async () => {
    for (const turn of [{ ...stopped, status: 'inProgress' as const }, { ...stopped, id: 'newer' }]) {
      const { rpc, calls, request } = fixture();
      rpc.mockImplementationOnce(async () => ({}));
      rpc.mockImplementationOnce(async () => ({ data: [turn] }));
      await expect(replaceInterruptedMessage(request, 'thread', item, 'Changed', {}, () => true, vi.fn())).rejects.toThrow('会话已发生变化');
      expect(calls.some(call => call.method === 'thread/revert')).toBe(false);
    }
  });
  it('does not edit a steering message or send after the selection changes', async () => {
    const { request, calls } = fixture();
    await expect(replaceInterruptedMessage(request, 'thread', { ...item, id: 'steer' }, 'Changed', {}, () => true, vi.fn()))
      .rejects.toThrow('原始消息');
    expect(calls.some(call => call.method === 'thread/revert')).toBe(false);
    const second = fixture();
    await expect(replaceInterruptedMessage(second.request, 'thread', item, 'Changed', {}, () => false, vi.fn()))
      .rejects.toThrow('原始消息');
    expect(second.calls.some(call => call.method === 'turn/start')).toBe(false);
  });
  it('retains the draft and never retries a mutation whose acknowledgement is lost', async () => {
    for (const failed of ['thread/revert', 'turn/start']) {
      const { request } = fixture();
      const calls: string[] = [];
      const rpc = (async (method, params) => {
        calls.push(method);
        if (method === failed) throw new Error('Connection closed');
        return request(method, params);
      }) as ChatTransport['rpc'];
      const failure = await replaceInterruptedMessage(rpc, 'thread', item, 'Draft', {}, () => true, vi.fn()).catch(error => error);
      expect(failure).toBeInstanceOf(MessageEditError);
      expect(failure.uncertain).toBe(true);
      expect(calls.filter(method => method === failed)).toHaveLength(1);
      if (failed === 'thread/revert') expect(calls).not.toContain('turn/start');
    }
  });
  it('does not resend when selection or transport changes after reverting', async () => {
    const { request, calls } = fixture();
    let current = true;
    const failure = await replaceInterruptedMessage(request, 'thread', item, 'Draft', {}, () => current,
      () => { current = false; }).catch(error => error);
    expect(failure).toBeInstanceOf(MessageEditError);
    expect(failure.uncertain).toBe(true);
    expect(calls.filter(call => call.method === 'thread/revert')).toHaveLength(1);
    expect(calls.some(call => call.method === 'turn/start')).toBe(false);
  });
});
