import { describe, expect, it } from 'vitest';
import { sideChatEvent, type SideChat } from './useSideChats';
import { queuedDraft, replaceQueuedText } from './queued-messages';
import { turnInput } from './slash-commands';

const chat: SideChat = { id: 'tab', threadId: 'side', title: 'Side chat', model: 'model', effort: 'high',
  permissions: ':read-only', mode: 'default', items: [], timings: {}, activeTurnId: null, error: null };

describe('independent temporary chat state', () => {
  it('keeps the current turn active when an earlier completion arrives late', () => {
    let state = sideChatEvent(chat, 'turn/started', { threadId: 'side',
      turn: { id: 'old', status: 'inProgress', startedAt: 100 } });
    state = sideChatEvent(state, 'item/completed', { threadId: 'side', turnId: 'old',
      item: { type: 'agentMessage', id: 'old-answer', text: 'Earlier' } });
    state = sideChatEvent(state, 'turn/started', { threadId: 'side',
      turn: { id: 'new', status: 'inProgress', startedAt: 200 } });
    state = sideChatEvent(state, 'item/completed', { threadId: 'side', turnId: 'new',
      item: { type: 'agentMessage', id: 'new-answer', text: 'Latest' } });
    state = sideChatEvent(state, 'turn/completed', { threadId: 'side',
      turn: { id: 'old', status: 'completed', startedAt: 100, completedAt: 150,
        items: [{ type: 'agentMessage', id: 'late', text: 'Delayed' }] } });
    expect(state.activeTurnId).toBe('new');
    expect(state.items.map(item => item.id)).toEqual(['old-answer', 'late', 'new-answer']);
  });
  it('keeps retrying and final errors in the owning turn without a stale global banner', () => {
    let state = sideChatEvent(chat, 'error', { threadId: 'side', turnId: 't', willRetry: true,
      error: { message: 'Limited', codexErrorInfo: 'rateLimitExceeded' } });
    expect(state.timings.t).toMatchObject({ error: { message: 'Limited' }, errorWillRetry: true });
    expect(state.error).toBeNull();
    state = sideChatEvent(state, 'turn/completed', { threadId: 'side', turn: {
      id: 't', status: 'failed', error: { message: 'Final', codexErrorInfo: 'rateLimitExceeded' }
    } });
    expect(state.timings.t).toMatchObject({ status: 'failed', error: { message: 'Final' } });
    expect(state.timings.t?.errorWillRetry).toBeUndefined();
  });
  it('uses native embedded order and newly supplied timing before inserting an older turn', () => {
    let state = sideChatEvent(chat, 'turn/started', { threadId: 'side',
      turn: { id: 'new', status: 'inProgress', startedAt: 200,
        items: [{ type: 'agentMessage', id: 'answer', text: 'Latest' }] } });
    state = sideChatEvent(state, 'turn/completed', { threadId: 'side',
      turn: { id: 'outside', status: 'completed', startedAt: 100, completedAt: 150,
        items: [{ type: 'agentMessage', id: 'outside-answer', text: 'Outside window' }] } });
    expect(state.items.map(item => item.id)).toEqual(['answer']);
    expect(state.activeTurnId).toBe('new');
    state = sideChatEvent(state, 'turn/completed', { threadId: 'side',
      turn: { id: 'new', status: 'completed', startedAt: 200, completedAt: 250,
        items: [{ type: 'agentMessage', id: 'commentary', phase: 'commentary', text: 'First' },
          { type: 'agentMessage', id: 'answer', text: 'Latest' }] } });
    expect(state.items.map(item => item.id)).toEqual(['commentary', 'answer']);
    expect(state.items[1]).toMatchObject({ text: 'Latest', turnId: 'new' });
  });
  it('isolates main and other tab events and replaces streamed text on completion', () => {
    expect(sideChatEvent(chat, 'turn/started', { threadId: 'main', turn: { id: 't' } })).toBe(chat);
    let state = sideChatEvent(chat, 'turn/started', { threadId: 'side', turn: { id: 't', status: 'inProgress' } });
    for (const delta of ['hello', ' world']) state = sideChatEvent(state, 'item/agentMessage/delta', {
      threadId: 'side', turnId: 't', itemId: 'a', delta
    });
    expect(state.items[0]).toMatchObject({ text: 'hello world', turnId: 't' });
    state = sideChatEvent(state, 'item/completed', { threadId: 'side', turnId: 't',
      item: { type: 'agentMessage', id: 'a', text: 'hello world', phase: 'final_answer' } });
    expect(state.items).toHaveLength(1);
    state = sideChatEvent(state, 'turn/completed', { threadId: 'side', turn: { id: 't', status: 'completed', durationMs: 400 } });
    expect(state.activeTurnId).toBeNull();
    expect(state.timings.t?.durationMs).toBe(400);
  });

  it('keeps queued images and skills when editing or opening in a side chat', () => {
    const input = turnInput('original', [{ url: 'data:image/png;base64,AA==' }], [
      { name: 'skill', path: '/skills/skill', description: '', enabled: true }
    ]);
    const edited = replaceQueuedText(input, 'changed');
    expect(edited.slice(1)).toEqual(input.slice(1));
    expect(queuedDraft(edited)).toMatchObject({ text: 'changed', attachments: [{ url: 'data:image/png;base64,AA==' }],
      skills: [{ path: '/skills/skill' }] });
  });

  it('renders an ephemeral reply supplied only inside the completed native turn', () => {
    const state = sideChatEvent(chat, 'turn/completed', { threadId: 'side',
      turn: { id: 't', status: 'completed', items: [{ type: 'agentMessage', id: 'a', text: 'OK' }] } });
    expect(state.items).toMatchObject([{ id: 'a', type: 'agentMessage', turnId: 't', text: 'OK' }]);
    expect(state.activeTurnId).toBeNull();
  });

  it('retains native work anchors through side-chat item and turn completion', () => {
    let state = sideChatEvent(chat, 'item/started', { threadId: 'side', turnId: 't', startedAtMs: 147_250,
      item: { type: 'agentMessage', id: 'a', phase: 'final_answer', text: '' } });
    state = sideChatEvent(state, 'item/completed', { threadId: 'side', turnId: 't', completedAtMs: 200_000,
      item: { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'OK' } });
    state = sideChatEvent(state, 'turn/completed', { threadId: 'side',
      turn: { id: 't', status: 'completed', items: [{ type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'OK' }] } });
    expect(state.items[0]).toMatchObject({ startedAtMs: 147_250, completedAtMs: 200_000 });
  });
});
