import { describe, expect, it, vi } from 'vitest';
import { readConversationHistoryPage, readThreadHistoryAround, readThreadHistoryPage, readThreadOutline } from './thread-history.js';

describe('native history paging', () => {
  it('uses the owning server for fresh history and only reports an active turn', async () => {
    const request = vi.fn(async (method: string) => method === 'thread/items/list'
      ? { data: [{ turnId: 'new', item: { id: 'b' } }, { turnId: 'old', item: { id: 'a' } }], nextCursor: 'opaque:cursor' }
      : { data: [{ id: 'new', status: 'completed' }] });
    const page = await readThreadHistoryPage(request, 'thread', null, 2);
    expect(page.items.map((entry) => entry.item)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.activeTurnId).toBeNull();
    expect(page.nextCursor).toBe('opaque:cursor');
    expect(request).toHaveBeenCalledWith('thread/items/list', { threadId: 'thread', limit: 2, sortDirection: 'desc' });
    expect(request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread', limit: 2, itemsView: 'notLoaded' });
  });

  it('preserves opaque cursors and avoids fetching turn metadata for older pages', async () => {
    const request = vi.fn(async () => ({ data: [], nextCursor: null }));
    await readThreadHistoryPage(request, 'thread', '{"ordinal":7000}', 200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('thread/items/list', {
      threadId: 'thread', limit: 200, sortDirection: 'desc', cursor: '{"ordinal":7000}'
    });
  });

  it('returns bounded native timing metadata and its cursor without hydrating entire turns', async () => {
    const turn = { id: 'active', status: 'inProgress', startedAt: 1792908818, completedAt: null, durationMs: null };
    const request = vi.fn(async (method: string) => method === 'thread/items/list'
      ? { data: [{ turnId: turn.id, item: { id: 'tool' } }], nextCursor: 'items:older' }
      : { data: [{ ...turn, items: [], unrelated: 'not forwarded' }], nextCursor: 'turns:older' });
    const page = await readThreadHistoryPage(request, 'thread', null, 40);
    expect(page).toMatchObject({ turns: [turn], turnsCursor: 'turns:older', activeTurnId: 'active' });
    expect(Object.keys(page.turns[0]!)).toEqual(['id', 'status', 'startedAt', 'completedAt', 'durationMs']);
  });

  it('coalesces invisible pages into one response until readable context, retaining every record', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: [{ turnId: 't', item: { type: 'commandExecution', id: 'command' } }], nextCursor: 'middle'
    }).mockResolvedValueOnce({
      data: [{ turnId: 't', item: { type: 'reasoning', id: 'reasoning' } }], nextCursor: 'older'
    }).mockResolvedValueOnce({
      data: [{ turnId: 't', item: { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Question' }] } }],
      nextCursor: 'before-question'
    });
    const page = await readConversationHistoryPage(request, 'thread', 'newest');
    expect(page.items.map(entry => (entry.item as { id: string }).id)).toEqual(['user', 'reasoning', 'command']);
    expect(page.nextCursor).toBe('before-question');
    expect(request.mock.calls.map(([, params]) => params.cursor)).toEqual(['newest', 'middle', 'older']);
  });

  it('bounds coalescing to four native pages and stops on an answer or image question', async () => {
    const request = vi.fn(async (_method: string, params: unknown) => ({
      data: [{ turnId: 't', item: { type: 'agentMessage', phase: 'commentary', text: 'Working' } }],
      nextCursor: `${(params as { cursor: string }).cursor}:older`
    }));
    const page = await readConversationHistoryPage(request, 'thread', 'start');
    expect(request).toHaveBeenCalledTimes(4);
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBe('start:older:older:older:older');
    for (const item of [
      { type: 'agentMessage', phase: 'final_answer', text: 'Answer' },
      { type: 'userMessage', content: [{ type: 'localImage', path: '/question.png' }] }
    ]) {
      const read = vi.fn().mockResolvedValue({ data: [{ turnId: 't', item }], nextCursor: 'older' });
      await readConversationHistoryPage(read, 'thread', 'start');
      expect(read).toHaveBeenCalledOnce();
    }
  });

  it('preserves a successful page and retry cursor when the next native page fails', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: [{ turnId: 't', item: { type: 'reasoning', id: 'reasoning' } }], nextCursor: 'retry'
    }).mockRejectedValueOnce(new Error('bridge unavailable'));
    const page = await readConversationHistoryPage(request, 'thread', 'start');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('retry');
    expect(page.continuationError).toBeTruthy();
  });

  it('stops repeated native cursors without duplicating the same page', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{ turnId: 't', item: { type: 'reasoning', id: 'reasoning' } }], nextCursor: 'start'
    });
    expect((await readConversationHistoryPage(request, 'thread', 'start')).items).toHaveLength(1);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('turn navigation', () => {
  const entry = (id: string, turnId = 'target') => ({ turnId, item: { id }, startedAtMs: null, completedAtMs: null });

  it('reads both sides of a native opaque cursor without filtering out adjacent turns', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [entry('user')], nextCursor: 'native:at-user' })
      .mockResolvedValueOnce({ data: [entry('before', 'previous')], nextCursor: 'native:older' })
      .mockResolvedValueOnce({ data: [entry('after'), entry('next', 'next-turn')], nextCursor: 'native:newer' });
    const page = await readThreadHistoryAround(request, 'thread', 'target', 'user');
    expect(page.items.map(e => e.item)).toEqual([{ id: 'before' }, { id: 'user' }, { id: 'after' }, { id: 'next' }]);
    expect(page).toMatchObject({ nextCursor: 'native:older', newerCursor: 'native:newer' });
    expect(request.mock.calls.slice(1).map(call => call[1])).toEqual([
      { threadId: 'thread', cursor: 'native:at-user', sortDirection: 'desc', limit: 40 },
      { threadId: 'thread', cursor: 'native:at-user', sortDirection: 'asc', limit: 40 }
    ]);
  });

  it('does not read unrelated endpoints when a single-item turn has no cursor', async () => {
    const request = vi.fn().mockResolvedValue({ data: [entry('only')], nextCursor: null });
    expect(await readThreadHistoryAround(request, 'thread', 'target', 'only')).toEqual({
      items: [entry('only')], nextCursor: null, newerCursor: null
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns a single-item target immediately and retains native cursors for automatic continuation', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [entry('only')], nextCursor: null, backwardsCursor: 'native:boundary' })
      .mockResolvedValueOnce({ data: [entry('only'), entry('old', 'before')], nextCursor: null })
      .mockResolvedValueOnce({ data: [entry('only'), entry('new', 'after')], nextCursor: null });
    const page = await readThreadHistoryAround(request, 'thread', 'target', 'only');
    expect(page.items.map(e => e.item)).toEqual([{ id: 'only' }]);
    expect(page).toMatchObject({ nextCursor: 'native:boundary', newerCursor: 'native:boundary' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('returns the request and full reply in one native read when the target is in the first turn page', async () => {
    const request = vi.fn().mockResolvedValue({ data: [entry('user'), entry('reply')],
      nextCursor: 'after-reply', backwardsCursor: 'before-user' });
    const page = await readThreadHistoryAround(request, 'thread', 'target', 'user');
    expect(page.items.map(e => e.item)).toEqual([{ id: 'user' }, { id: 'reply' }]);
    expect(page).toMatchObject({ nextCursor: 'before-user', newerCursor: 'after-reply' });
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/items/list', {
      threadId: 'thread', turnId: 'target', limit: 100, sortDirection: 'asc'
    });
  });

  it('locates a steering message using its predecessor, including a second message in the turn', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [entry('first')], nextCursor: 'native:first' })
      .mockResolvedValueOnce({ data: [entry('first')], nextCursor: null })
      .mockResolvedValueOnce({ data: [], nextCursor: null })
      .mockResolvedValueOnce({ data: [entry('steering')], nextCursor: 'native:after' });
    const page = await readThreadHistoryAround(request, 'thread', 'target', 'steering');
    expect(page.items.map(e => e.item)).toEqual([{ id: 'first' }, { id: 'steering' }]);
    expect(request.mock.calls[1]![1]).toMatchObject({ turnId: 'target', cursor: { type: 'item', itemId: 'steering' } });
    expect(request.mock.calls[2]![1]).toMatchObject({ cursor: 'native:first' });
  });

  it('keeps ascending pages chronological for forward navigation', async () => {
    const request = vi.fn().mockResolvedValue({ data: [entry('a'), entry('b')], nextCursor: 'forward' });
    const page = await readThreadHistoryPage(request, 'thread', 'anchor', 40, 'asc');
    expect(page.items.map(e => e.item)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns compact chronological outline entries with cleaned prompts and final replies only', async () => {
    const request = vi.fn().mockResolvedValue({ data: [{
      id: 'turn', status: 'completed', startedAt: 100, completedAt: 101, durationMs: 1000,
      items: [
        { type: 'userMessage', id: 'user', content: [{ type: 'text', text: '# Files mentioned by the user:\nsecret/path\n## My request:\nVisible prompt' }] },
        { type: 'commandExecution', id: 'tool', command: 'PRIVATE_TOOL_OUTPUT' },
        { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'PRIVATE_PROGRESS' },
        { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Visible reply '.repeat(100) }
      ]
    }], nextCursor: 'outline:older' });
    const page = await readThreadOutline(request, 'thread', 'outline:cursor');
    expect(page.turns[0]!.messages[0]).toMatchObject({ itemId: 'user', prompt: 'Visible prompt' });
    expect(page.turns[0]!.messages[0]!.reply.length).toBe(360);
    expect(JSON.stringify(page)).not.toMatch(/secret|PRIVATE/);
    expect(page.nextCursor).toBe('outline:older');
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread', cursor: 'outline:cursor', itemsView: 'summary', limit: 100
    });
  });
});
