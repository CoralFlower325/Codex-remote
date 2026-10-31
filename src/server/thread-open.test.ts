import { describe, expect, it, vi } from 'vitest';
import { readOpenThread, readThreadTimings } from './thread-open.js';

const entry = (id: string, type: string, fields = {}) => ({
  turnId: 'turn', item: { id, type, ...fields }, startedAtMs: null, completedAtMs: null
});

describe('HTTP timing pagination', () => {
  it('reads opaque older cursors independently of the browser realtime connection', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{ id: 'old', status: 'failed', startedAt: 1, completedAt: 2, durationMs: 1000, items: ['private'],
        error: { message: 'Native limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: 'Synthetic detail' } }],
      nextCursor: 'next:native'
    });
    const page = await readThreadTimings(request, 'thread', 'opaque:native');
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread', cursor: 'opaque:native', limit: 100, itemsView: 'notLoaded'
    });
    expect(page.turnsCursor).toBe('next:native');
    expect(page.turns[0]).not.toHaveProperty('items');
    expect(page.turns[0]?.error).toMatchObject({ message: 'Native limit', codexErrorInfo: 'usageLimitExceeded' });
  });
});
const user = () => entry('user', 'userMessage', { content: [{ type: 'text', text: 'Question' }] });
const answer = () => entry('answer', 'agentMessage', { text: 'Answer', phase: 'final_answer' });
const activity = (size: number, prefix = 'r') => Array.from({ length: size }, (_, index) =>
  entry(`${prefix}${index}`, 'reasoning', { summary: [], content: [] }));

describe('opening a read-only chat without waiting for interaction setup', () => {
  it('does not download folded command bodies when switching chats', async () => {
    const command = entry('cmd', 'commandExecution', { command: 'echo example', status: 'completed',
      aggregatedOutput: 'synthetic output '.repeat(20000), exitCode: 0, durationMs: 1 });
    const request = vi.fn(async (method: string) => method === 'thread/read'
      ? { thread: { id: 'chat' } } : { data: [answer(), command, user()], nextCursor: null });
    const page = await readOpenThread(request, 'chat', 'resume');
    console.debug('[history-regression] initial payload', { bytes: JSON.stringify(page).length });
    expect(JSON.stringify(page).length).toBeLessThan(4096);
    expect(page.items[1]?.item).toMatchObject({ id: 'cmd', detailsDeferred: true });
    expect(page.items[0]?.item).toEqual(user().item);
    expect(page.items[2]?.item).toEqual(answer().item);
  });

  it('reads a small latest page without resuming or waiting for turn metadata', async () => {
    const request = vi.fn(async (method: string) => method === 'thread/read'
      ? { thread: { id: 'chat' } }
      : { data: [answer(), user()], nextCursor: method === 'thread/items/list' ? 'older' : null });
    const page = await readOpenThread(request, 'chat', 'resume');
    expect(page.result).toEqual({ thread: { id: 'chat' } });
    expect(page.nextCursor).toBe('older');
    expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'chat', includeTurns: false });
    expect(request).toHaveBeenCalledWith('thread/items/list', { threadId: 'chat', limit: 40, sortDirection: 'desc' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.timingsPending).toBe(true);
    expect(page.items.map(value => (value.item as { id: string }).id)).toEqual(['user', 'answer']);
  });

  it('automatically fills a tool-heavy tail through native cursors without dropping latest items', async () => {
    const latest = [answer(), ...activity(39)];
    const older = Array.from({ length: 100 }, (_, index) => entry(`c${index}`, 'commandExecution'));
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/read') return { thread: { id: 'chat' } };
      const cursor = (params as { cursor?: string }).cursor;
      if (!cursor) return { data: latest, nextCursor: 'middle' };
      if (cursor === 'middle') return { data: older, nextCursor: 'oldest' };
      return { data: [user()], nextCursor: 'remaining' };
    });
    const page = await readOpenThread(request, 'chat', 'resume');
    expect(request).toHaveBeenCalledWith('thread/items/list', {
      threadId: 'chat', limit: 100, sortDirection: 'desc', cursor: 'middle'
    });
    expect(page.items).toEqual([user(), ...older.toReversed(), ...latest.toReversed()]);
    expect(page.nextCursor).toBe('remaining');
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('fills pure hidden reasoning until user and a final answer are available', async () => {
    const request = vi.fn(async (method: string, params: unknown) => method === 'thread/read'
      ? { thread: { id: 'chat' } }
      : (params as { cursor?: string }).cursor
        ? { data: [answer(), user()], nextCursor: null }
        : { data: activity(40), nextCursor: 'older' });
    const page = await readOpenThread(request, 'chat', 'read');
    expect(page.items.slice(0, 2)).toEqual([user(), answer()]);
    expect(page.items).toHaveLength(42);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps the initial window bounded even when commentary and blank user content do not provide context', async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/read') return { thread: { id: 'chat' } };
      const { cursor, limit } = params as { cursor?: string; limit: number };
      return {
        data: Array.from({ length: limit }, (_, index) => entry(`${cursor ?? 'latest'}-${index}`,
          index % 2 ? 'userMessage' : 'agentMessage', index % 2
            ? { content: [{ type: 'text', text: '  ' }] } : { text: 'Progress', phase: 'commentary' })),
        nextCursor: cursor ? cursor + '-older' : 'older'
      };
    });
    const page = await readOpenThread(request, 'chat', 'resume');
    expect(page.items).toHaveLength(240);
    expect(page.nextCursor).toBe('older-older-older');
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('accepts image-only user messages and legacy assistant answers as visible context', async () => {
    const request = vi.fn(async (method: string) => method === 'thread/read' ? { thread: { id: 'chat' } }
      : { data: [entry('legacy', 'agentMessage', { text: 'Answer' }),
        entry('image', 'userMessage', { content: [{ type: 'localImage', path: '/image.png' }] })], nextCursor: 'older' });
    await readOpenThread(request, 'chat', 'resume');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not repeatedly follow an unchanged cursor', async () => {
    const request = vi.fn(async (method: string, params: unknown) => method === 'thread/read'
      ? { thread: { id: 'chat' } }
      : { data: activity((params as { limit: number }).limit), nextCursor: 'same' });
    const page = await readOpenThread(request, 'chat', 'resume');
    expect(page.items).toHaveLength(140);
    expect(page.nextCursor).toBe('same');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('retains successful pages and their retry cursor when an additional page fails', async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/read') return { thread: { id: 'chat' } };
      const cursor = (params as { cursor?: string }).cursor;
      if (!cursor) return { data: activity(40, 'latest'), nextCursor: 'middle' };
      if (cursor === 'middle') return { data: activity(100, 'middle'), nextCursor: 'retry' };
      throw new Error('Additional history unavailable');
    });
    const page = await readOpenThread(request, 'chat', 'resume');
    expect(page.items).toHaveLength(140);
    expect(page.nextCursor).toBe('retry');
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('still reports a failed initial page rather than silently returning an empty chat', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { id: 'chat' } };
      throw new Error('Initial history unavailable');
    });
    await expect(readOpenThread(request, 'chat', 'resume')).rejects.toThrow('Initial history unavailable');
  });

  it('does not resume or load history for an unsent new chat', async () => {
    const request = vi.fn(async () => ({ thread: { id: 'unsent' } }));
    const page = await readOpenThread(request, 'unsent', 'new');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'unsent', includeTurns: false });
    expect(page.items).toEqual([]);
  });

  it('reads archived chats without resuming them', async () => {
    const request = vi.fn(async (method: string) => method === 'thread/read'
      ? { thread: { id: 'chat' } } : { data: [], nextCursor: null });
    await readOpenThread(request, 'chat', 'read');
    expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'chat', includeTurns: false });
    expect(request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
  });
});
