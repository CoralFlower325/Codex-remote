import { afterEach, describe, expect, it, vi } from 'vitest';
import { EphemeralChats } from './ephemeral-chats.js';

afterEach(() => vi.useRealTimers());
describe('temporary chat ownership', () => {
  it('keeps native retry errors in reconnect memory and clears them on resumed output', () => {
    const chats = new EphemeralChats<string>(async () => {});
    chats.add('side', 'socket');
    chats.record('turn/started', { threadId: 'side', turn: { id: 't', status: 'inProgress' } });
    chats.record('error', { threadId: 'side', turnId: 't', willRetry: true,
      error: { message: 'Native retry', codexErrorInfo: 'serverOverloaded' } });
    expect(chats.snapshot('side')?.turns[0]).toMatchObject({ errorWillRetry: true, error: { message: 'Native retry' } });
    chats.record('item/agentMessage/delta', { threadId: 'side', turnId: 't', itemId: 'a', delta: 'Recovered' });
    expect(chats.snapshot('side')?.turns[0]?.error).toBeUndefined();
  });
  it('keeps reconnected chats but releases abandoned tabs after the disconnect grace', async () => {
    vi.useFakeTimers();
    const release = vi.fn().mockResolvedValue({});
    const chats = new EphemeralChats<string>(release, 100);
    chats.add('side', 'old');
    chats.disconnect('old');
    chats.claim(['side'], 'new');
    await vi.advanceTimersByTimeAsync(101);
    expect(release).not.toHaveBeenCalled();
    chats.disconnect('new');
    await vi.advanceTimersByTimeAsync(101);
    expect(release).toHaveBeenCalledExactlyOnceWith('side');
  });

  it('restores streamed temporary history without native persisted-history APIs', () => {
    const chats = new EphemeralChats<string>(async () => {});
    chats.add('side', 'socket');
    chats.record('item/agentMessage/delta', { threadId: 'side', turnId: 't', itemId: 'a', delta: 'A' });
    chats.record('item/agentMessage/delta', { threadId: 'main', turnId: 't', itemId: 'a', delta: 'wrong' });
    chats.record('item/completed', { threadId: 'side', turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'AB' } });
    chats.record('turn/completed', { threadId: 'side', turn: { id: 't', status: 'completed' } });
    expect(chats.snapshot('side')).toMatchObject({ items: [{ id: 'a', turnId: 't', text: 'AB' }], activeTurnId: null });
    chats.remove('side');
    expect(chats.snapshot('side')).toBeNull();
  });

  it('recovers submitted input and replies when Desktop sends only turn-level items', () => {
    const chats = new EphemeralChats<string>(async () => {});
    chats.add('side', 'socket');
    chats.recordInput('side', 't', 'user', [{ type: 'text', text: 'Question' }]);
    chats.record('turn/completed', { threadId: 'side', turn: { id: 't', status: 'completed',
      items: [{ id: 'a', type: 'agentMessage', text: 'OK' }] } });
    expect(chats.snapshot('side')?.items).toMatchObject([
      { type: 'userMessage', turnId: 't', content: [{ text: 'Question' }] },
      { type: 'agentMessage', turnId: 't', text: 'OK' }
    ]);
  });

  it('keeps native reply timing in reconnect snapshots after embedded turn items replace the reply', () => {
    const chats = new EphemeralChats<string>(async () => {});
    chats.add('side', 'socket');
    chats.record('item/started', { threadId: 'side', turnId: 't', startedAtMs: 147_250,
      item: { type: 'agentMessage', id: 'a', phase: 'final_answer', text: '' } });
    chats.record('item/completed', { threadId: 'side', turnId: 't', completedAtMs: 200_000,
      item: { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'OK' } });
    chats.record('turn/completed', { threadId: 'side', turn: { id: 't', status: 'completed',
      items: [{ type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'OK' }] } });
    expect(chats.snapshot('side')?.items[0]).toMatchObject({ startedAtMs: 147_250, completedAtMs: 200_000 });
  });
});
