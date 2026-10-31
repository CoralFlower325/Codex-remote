import { describe, expect, it } from 'vitest';

import { displayThreadTitle, findActiveTurnId, mergeEmbeddedTurnItems, mergeLatestHistoryItems, mergeOlderHistoryItems, mergeOlderTurnTimings, reconcileThreadList, upsertItem } from './remote-state';
import type { TurnTiming } from '../shared/turn-timing';
import type { Thread, ThreadItem } from './types';

describe('remote thread state', () => {
  it('does not roll completed child timing back when an earlier speculative page is consumed', () => {
    const completed: TurnTiming = { id: 'child', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 };
    const prefetched: TurnTiming = { ...completed, status: 'inProgress', completedAt: null, durationMs: null };
    const missing = { ...completed, id: 'older' };
    const merged = mergeOlderTurnTimings({ child: completed }, [prefetched, missing]);
    expect(merged.child).toBe(completed);
    expect(merged.older).toBe(missing);
  });
  it('keeps live additions, renames and removals while paginated reconciliation finishes', () => {
    const task = (id: string, name = id) => ({ id, name, updatedAt: 10 } as Thread);
    const unchanged = task('unchanged');
    const renamed = task('renamed');
    const removed = task('removed');
    const live = task('new');
    const changed = { ...renamed, name: 'Live title' };
    const result = reconcileThreadList([unchanged, changed, live],
      [task('unchanged'), task('renamed'), task('removed'), task('older')],
      [unchanged, renamed, removed]);
    expect(result.map(thread => thread.id).sort()).toEqual(['new', 'older', 'renamed', 'unchanged']);
    expect(result.find(thread => thread.id === 'renamed')).toBe(changed);
  });
  it('replaces unchanged paginated rows and keeps a newly loaded row archived during pagination', () => {
    const old = { id: 'existing', name: 'Old', updatedAt: 1 } as Thread;
    const loaded = { id: 'page-two', name: 'Page two', updatedAt: 2 } as Thread;
    const latest = { ...old, name: 'Snapshot title', updatedAt: 3 };
    const baseline = [old, loaded];
    expect(reconcileThreadList([old], [latest, { ...loaded }], baseline)).toEqual([latest]);
  });
  it('preserves live updates received after a history request began and inserts missing items in order', () => {
    const message = (id: string, text = id): ThreadItem => ({ type: 'agentMessage', id, text });
    const baseline = [message('old'), message('shared', 'partial')];
    const streamed = { ...baseline[1]!, text: 'partial and live' } as ThreadItem;
    expect(mergeLatestHistoryItems(
      [baseline[0]!, streamed, message('live')],
      [message('missing'), message('shared', 'partial')],
      baseline
    )).toEqual([baseline[0], message('missing'), streamed, message('live')]);
  });
  it('keeps reused item ids in separate turns and retains unchanged objects', () => {
    const first: ThreadItem = { type: 'agentMessage', id: '0', turnId: 'one', text: 'First' };
    const second: ThreadItem = { type: 'agentMessage', id: '0', turnId: 'two', text: 'Second' };
    expect(upsertItem([first], second)).toEqual([first, second]);
    expect(mergeOlderHistoryItems([first], [second])).toEqual([first, second]);
    const items = [first, second];
    expect(mergeLatestHistoryItems(items, [{ ...second }])).toBe(items);
    expect(mergeLatestHistoryItems(items, [{ ...second, text: 'Updated' }])).toEqual([first, { ...second, text: 'Updated' }]);
  });
  it('follows native history order after delayed events without duplicating or rewinding live text', () => {
    const answer: ThreadItem = { type: 'agentMessage', id: 'answer', turnId: 'old', text: 'Answer' };
    const command: ThreadItem = { type: 'commandExecution', id: 'command', turnId: 'old',
      command: 'echo test', cwd: '/project', status: 'completed', aggregatedOutput: 'test',
      exitCode: 0, durationMs: 1 };
    const user: ThreadItem = { type: 'userMessage', id: 'user', turnId: 'new', content: [] };
    const partial: ThreadItem = { type: 'agentMessage', id: 'answer', turnId: 'new', text: 'Partial' };
    const live: ThreadItem = { ...partial, text: 'Partial plus live' };
    const baseline = [answer, command, user, partial];
    const current = [answer, command, user, live];
    const native = [command, answer, user, partial];
    const result = mergeLatestHistoryItems(current, native, baseline);
    expect(result).toEqual([command, answer, user, live]);
    expect(new Set(result.map(item => JSON.stringify([item.turnId, item.id]))).size).toBe(result.length);
    expect(mergeLatestHistoryItems(result, native, baseline)).toBe(result);
  });
  it('keeps every authoritative permutation once while retaining a live-only neighbour', () => {
    const message = (id: string): ThreadItem => ({ type: 'agentMessage', id, turnId: 't', text: id });
    const a = message('a'), b = message('b'), c = message('c'), live = message('live');
    for (const native of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      const result = mergeLatestHistoryItems([a, b, live, c], native);
      expect(result.filter(item => item !== live)).toEqual(native);
      expect(result.filter(item => item === live)).toHaveLength(1);
      expect(result.indexOf(live)).toBeLessThan(result.indexOf(c));
    }
  });
  it('restores the latest in-progress turn', () => {
    expect(
      findActiveTurnId([
        { id: 'done', status: 'completed', items: [], startedAt: null, completedAt: null, durationMs: null },
        { id: 'active', status: 'inProgress', items: [], startedAt: null, completedAt: null, durationMs: null }
      ])
    ).toBe('active');
  });

  it('appends streamed agent text without replacing existing content', () => {
    const items: ThreadItem[] = [{ type: 'agentMessage', id: 'agent-1', text: 'hello' }];
    expect(
      upsertItem(items, { type: 'agentMessage', id: 'agent-1', text: ' world' }, true)
    ).toEqual([{ type: 'agentMessage', id: 'agent-1', text: 'hello world' }]);
  });

  it('keeps delayed items and deltas inside their earlier turn before newer messages', () => {
    const old: ThreadItem = { type: 'agentMessage', id: 'old-answer', turnId: 'old', text: 'Earlier answer' };
    const user: ThreadItem = { type: 'userMessage', id: 'new-user', turnId: 'new', content: [] };
    const answer: ThreadItem = { type: 'agentMessage', id: 'new-answer', turnId: 'new', text: 'Latest answer' };
    const late: ThreadItem = { type: 'agentMessage', id: 'late', turnId: 'old', text: 'Delayed' };
    const before = [old, user, answer];
    const inserted = upsertItem(before, late, true);
    expect(inserted).toEqual([old, late, user, answer]);
    const streamed = upsertItem(inserted, { ...late, text: ' output' }, true);
    expect(streamed.map(item => item.id)).toEqual(['old-answer', 'late', 'new-user', 'new-answer']);
    expect(streamed[1]).toMatchObject({ text: 'Delayed output' });
    expect(before).toEqual([old, user, answer]);
  });

  it('does not append unseen older-turn events outside the loaded native history window', () => {
    const user: ThreadItem = { type: 'userMessage', id: 'user', turnId: 'new', content: [] };
    const late: ThreadItem = { type: 'agentMessage', id: 'late', turnId: 'old', text: 'Old output' };
    const timings: Record<string, TurnTiming> = {
      old: { id: 'old', status: 'completed', startedAt: 100, completedAt: 7293, durationMs: 7_193_000 },
      new: { id: 'new', status: 'inProgress', startedAt: 8000, completedAt: null, durationMs: null }
    };
    const current = [user];
    expect(upsertItem(current, late, false, timings)).toBe(current);
    expect(upsertItem(current, late, true, timings)).toBe(current);
    expect(mergeEmbeddedTurnItems(current, 'old', [late], false, timings)).toBe(current);
    const final: ThreadItem = { ...late, id: 'final', turnId: 'new' };
    expect(upsertItem(current, final, false, timings)).toEqual([user, final]);
    expect(upsertItem(current, { ...late, turnId: 'unknown' }, false, timings))
      .toEqual([user, { ...late, turnId: 'unknown' }]);
  });

  it('preserves native start anchors across deltas and completion notifications', () => {
    const started: ThreadItem = { type: 'agentMessage', id: 'answer', text: '', phase: 'final_answer', startedAtMs: 147_250 };
    const streamed = upsertItem([started], { type: 'agentMessage', id: 'answer', text: 'Answer' }, true);
    expect(streamed[0]).toMatchObject({ startedAtMs: 147_250, phase: 'final_answer' });
    const completed = upsertItem(streamed, { type: 'agentMessage', id: 'answer', text: 'Answer',
      phase: 'final_answer', completedAtMs: 200_000 });
    expect(completed[0]).toMatchObject({ startedAtMs: 147_250, completedAtMs: 200_000 });
  });

  it('uses a stable fallback title', () => {
    const thread: Thread = {
      id: 'thread-1',
      name: null,
      preview: '',
      cwd: 'C:\\workspace',
      projectId: null,
      model: null,
      modelProvider: 'openai',
      reasoningEffort: null,
      createdAt: 0,
      updatedAt: 0,
      status: { type: 'idle' }
    };
    expect(displayThreadTitle(thread)).toBe('未命名任务');
  });
});


describe('embedded native turn messages', () => {
  it('merges a large payload once without duplicate IDs and preserves timing anchors', () => {
    const first: ThreadItem = { type: 'agentMessage', id: 'a', turnId: 'first', text: 'Earlier', startedAtMs: 100 };
    const sameId: ThreadItem = { ...first, turnId: 'second', text: 'Other turn' };
    const incoming = [{ ...first, startedAtMs: null, text: 'Updated' },
      ...Array.from({ length: 1000 }, (_, index) => ({ type: 'agentMessage', id: `next-${index}`, text: 'Synthetic' })),
      { type: 'agentMessage', id: 'next-1', text: 'Final' }, null, {}, { type: 'agentMessage', id: 42 }];
    const result = mergeEmbeddedTurnItems([first, sameId], 'first', incoming, false);
    expect(result).toHaveLength(1002);
    expect(result[0]).toMatchObject({ text: 'Updated', startedAtMs: 100 });
    expect(result.at(-1)).toBe(sameId);
    expect(result.find(item => item.id === 'next-1')).toMatchObject({ text: 'Final', turnId: 'first' });
    expect(first.text).toBe('Earlier');
  });
  it('inserts missed embedded messages around known items before a later turn', () => {
    const message = (id: string, turnId = 'first'): ThreadItem => ({ type: 'agentMessage', id, turnId, text: id });
    const later = message('later', 'second');
    const current = [message('middle'), later];
    const result = mergeEmbeddedTurnItems(current, 'first',
      [message('question'), message('middle'), message('final')], false);
    expect(result.map(item => item.id)).toEqual(['question', 'middle', 'final', 'later']);
    expect(result.at(-1)).toBe(later);
    expect(current.map(item => item.id)).toEqual(['middle', 'later']);
  });
  it('restores native order after out-of-order item events without duplicating known items', () => {
    const message = (id: string): ThreadItem => ({ type: 'agentMessage', id, turnId: 'first', text: id });
    const local = message('local');
    const result = mergeEmbeddedTurnItems([local, message('final'), message('question')], 'first',
      [message('question'), message('final'), message('final')], false);
    expect(result.map(item => item.id)).toEqual(['local', 'question', 'final']);
    expect(result[0]).toBe(local);
  });
  it('keeps the local prefix when a turn notification contains only a new question', () => {
    const message = (id: string): ThreadItem => ({ type: 'agentMessage', id, turnId: 'first', text: id });
    const current = [message('context'), message('final')];
    expect(mergeEmbeddedTurnItems(current, 'first', [message('question')], false).map(item => item.id))
      .toEqual(['context', 'final', 'question']);
  });
  it('updates only known identities in an older history window and ignores invalid payloads', () => {
    const items: ThreadItem[] = [{ type: 'agentMessage', id: 'known', turnId: 'old', text: 'Old' }];
    expect(mergeEmbeddedTurnItems(items, 'new', [{ type: 'agentMessage', id: 'new', text: 'New' }], true)).toBe(items);
    expect(mergeEmbeddedTurnItems(items, 'old', [null, {}, { type: 'agentMessage', id: '' }], false)).toBe(items);
    expect(mergeEmbeddedTurnItems(items, 'old', null, false)).toBe(items);
    expect(mergeEmbeddedTurnItems(items, 'old', [{ type: 'agentMessage', id: 'known', text: 'Completed' }], true)[0])
      .toMatchObject({ id: 'known', text: 'Completed' });
  });
});
