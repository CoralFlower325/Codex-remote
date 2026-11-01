import { describe, expect, it } from 'vitest';

import { buildTimelineEntries, buildTimelineSections, isActivityIssue, timelineTurnResponses } from './timeline-model';
import { elapsedTurnMs } from '../shared/turn-timing';
import type { ThreadItem } from './types';

function command(id: string, status: 'inProgress' | 'completed' | 'failed' | 'declined' = 'completed'): ThreadItem {
  return {
    type: 'commandExecution',
    id,
    command: 'echo test',
    cwd: 'F:\\Example',
    status,
    aggregatedOutput: null,
    exitCode: status === 'failed' ? 1 : status === 'completed' ? 0 : null,
    durationMs: null
  };
}

function agent(id: string): Extract<ThreadItem, { type: 'agentMessage' }> {
  return { type: 'agentMessage', id, text: 'Done' };
}

describe('timeline model', () => {
  it('merges consecutive commands into a native foldable row', () => {
    const entries = buildTimelineEntries([
      command('one'),
      command('two', 'failed')
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'activity',
      kind: 'command',
      failedCount: 1,
      running: false
    });
    expect(entries[0]?.type === 'activity' ? entries[0].items : []).toHaveLength(2);
  });

  it('keeps messages between separate activity runs', () => {
    const entries = buildTimelineEntries([
      command('one'),
      agent('answer-one'),
      command('two', 'inProgress'),
      agent('answer-two')
    ]);

    expect(entries.map((entry) => entry.type)).toEqual([
      'activity',
      'message',
      'activity',
      'message'
    ]);
    expect(entries[2]).toMatchObject({ type: 'activity', running: false });
  });

  it('preserves commentary between native operation summaries and the final answer', () => {
    const entries = buildTimelineEntries([
      { type: 'userMessage', id: 'user', content: [], turnId: 't', startedAtMs: 1000 },
      { ...agent('intro'), turnId: 't', phase: 'commentary' },
      { ...command('one'), turnId: 't' },
      { ...agent('progress'), turnId: 't', phase: 'commentary' },
      { ...command('two'), turnId: 't' },
      { ...agent('final'), turnId: 't', phase: 'final_answer', startedAtMs: 1000, completedAtMs: 9000 }
    ]);
    expect(entries.map((entry) => entry.type)).toEqual(['message', 'message', 'activity', 'message', 'activity', 'message']);
    expect(entries[3]).toMatchObject({ type: 'message', item: { id: 'progress' } });
    expect(entries[5]).toMatchObject({ type: 'message', item: { id: 'final' } });
  });

  it('keeps an activity group mounted when more output arrives', () => {
    const first = command('one');
    const initial = buildTimelineEntries([first]);
    const updated = buildTimelineEntries([first, command('two'), agent('final')]);
    expect(initial[0]?.key).toBe(updated[0]?.key);
  });

  it('counts declined operations separately from tool failures', () => {
    const items = [command('failure', 'failed'), command('refused', 'declined'), command('ok')];
    const entries = buildTimelineEntries(items);
    expect(entries[0]).toMatchObject({ failedCount: 1, declinedCount: 1 });
    expect(items.filter(isActivityIssue).map((item) => item.id)).toEqual(['failure', 'refused']);
  });

  it('does not keep completed or interrupted turns spinning because of stale item status', () => {
    const items = [{ ...command('stale', 'inProgress'), turnId: 'old' }];
    expect(buildTimelineEntries(items, null)[0]).toMatchObject({ running: false });
    expect(buildTimelineEntries(items, 'new')[0]).toMatchObject({ running: false });
  });

  it('hides reasoning without retaining a stale spinner from another turn', () => {
    const entries = buildTimelineEntries([
      { ...command('stale', 'inProgress'), turnId: 'old' },
      { type: 'reasoning', id: 'thinking', summary: ['Thinking'], content: [], turnId: 'current' }
    ], 'current');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ running: false });
  });

  it('stops the activity indicator when the active turn starts its final reply', () => {
    const entries = buildTimelineEntries([
      { ...command('tool', 'inProgress'), turnId: 'current' },
      { ...agent('final'), turnId: 'current', phase: 'final_answer' }
    ], 'current');
    expect(entries[0]).toMatchObject({ type: 'activity', running: false });
    expect(entries[1]).toMatchObject({ type: 'message' });
  });

  it('combines native commands, edits and search, hides reasoning, and keeps image/compaction boundaries', () => {
    const entries = buildTimelineEntries([
      command('one'),
      { type: 'fileChange', id: 'edit', status: 'completed', changes: [{ path: 'src/app.ts' }] },
      { type: 'reasoning', id: 'think', summary: ['Thinking'], content: [] },
      { type: 'webSearch', id: 'search', query: 'Native app server' },
      { type: 'imageView', id: 'image', path: 'C:/Projects/example.png' },
      { type: 'contextCompaction', id: 'compact' }
    ]);
    expect(entries.map((entry) => entry.type === 'activity' ? entry.kind : entry.type))
      .toEqual(['file', 'image', 'event']);
    expect(entries[0]).toMatchObject({ kinds: ['command', 'file', 'search'], items: [{ id: 'one' }, { id: 'edit' }, { id: 'search' }] });
  });

  it('does not show empty native reasoning records or let them split consecutive commands', () => {
    const entries = buildTimelineEntries([
      command('one'),
      { type: 'reasoning', id: 'empty', summary: [], content: ['  '] },
      command('two'),
      { type: 'reasoning', id: 'visible', summary: ['Inspecting files'], content: [] }
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'activity', kind: 'command', items: [{ id: 'one' }, { id: 'two' }] });
  });

  it('does not combine activity from different turns or across commentary', () => {
    const entries = buildTimelineEntries([
      { ...command('a'), turnId: 'old' },
      { ...command('b'), turnId: 'new' },
      { ...agent('commentary'), phase: 'commentary', turnId: 'new' },
      { type: 'fileChange', id: 'edit', status: 'completed', changes: [], turnId: 'new' }
    ]);
    expect(entries.map(entry => entry.type)).toEqual(['activity', 'activity', 'message', 'activity']);
  });

  it('keeps user steering visible and assigns a single duration to the first response slice', () => {
    const sections = buildTimelineSections(buildTimelineEntries([
      { type: 'userMessage', id: 'u', content: [], turnId: 't' },
      { ...agent('progress'), phase: 'commentary', turnId: 't' },
      { type: 'userMessage', id: 'steer', content: [], turnId: 't' },
      { ...command('c'), turnId: 't' },
      { ...agent('answer'), phase: 'final_answer', turnId: 't' }
    ]));
    expect(sections.map(section => [section.user, section.showTiming, section.entries.length]))
      .toEqual([[true, false, 1], [false, true, 1], [true, false, 1], [false, false, 2]]);
  });

  it('keeps the original work clock and final-answer anchor across steering slices and other turns', () => {
    const items: ThreadItem[] = [
      { type: 'userMessage', id: 'u', content: [], turnId: 't', startedAtMs: 100_000 },
      { ...agent('progress'), phase: 'commentary', turnId: 't' },
      { type: 'userMessage', id: 'steer', content: [], turnId: 't', startedAtMs: 140_000 },
      { ...command('c'), turnId: 't' },
      { ...agent('answer'), phase: 'final_answer', turnId: 't', startedAtMs: 147_250, completedAtMs: 200_000 },
      { type: 'userMessage', id: 'new-user', content: [], turnId: 'new' },
      { ...agent('new-answer'), phase: 'final_answer', turnId: 'new', startedAtMs: 300_000 }
    ];
    const sections = buildTimelineSections(buildTimelineEntries(items));
    const turns = timelineTurnResponses(sections);
    expect(sections.filter(section => section.showTiming).map(section => section.turnId)).toEqual(['t', 'new']);
    expect(sections[1]?.showTiming).toBe(true);
    expect(turns.get('t')).toEqual({
      finalStartedAtMs: 147_250, hasTrace: true, lastResponseKey: sections[3]!.key
    });
    const timing = { id: 't', status: 'inProgress' as const, startedAt: 100, completedAt: null, durationMs: null };
    expect(elapsedTurnMs(timing, 999_000, turns.get('t')!.finalStartedAtMs)).toBe(47_250);
    expect(elapsedTurnMs({ ...timing, status: 'completed', completedAt: 200 }, 999_000,
      turns.get('t')!.finalStartedAtMs)).toBe(47_250);
    expect(turns.get('new')?.finalStartedAtMs).toBe(300_000);
  });

  it('moves only timing ownership to the earlier native response when a partial turn is paged in', () => {
    const tail: ThreadItem[] = [
      { type: 'userMessage', id: 'steer', content: [], turnId: 't' },
      { ...agent('answer'), phase: 'final_answer', turnId: 't', startedAtMs: 147_250 }
    ];
    const previous = buildTimelineSections(buildTimelineEntries(tail));
    const next = buildTimelineSections(buildTimelineEntries([
      { ...agent('progress'), phase: 'commentary', turnId: 't' }, ...tail
    ]), previous);
    expect(next.map(section => section.showTiming)).toEqual([true, false, false]);
    expect(next[2]!.key).toBe(previous[1]!.key);
    expect(timelineTurnResponses(next).get('t')?.finalStartedAtMs).toBe(147_250);
  });
  it('retains a partial response and its open activity when earlier items arrive', () => {
    const tail: ThreadItem[] = [
      { ...command('second'), turnId: 't' }, { ...agent('answer'), turnId: 't' }
    ];
    const initial = buildTimelineEntries(tail);
    const sections = buildTimelineSections(initial);
    const updated = buildTimelineEntries([{ ...command('first'), turnId: 't' }, ...tail], null, initial);
    const next = buildTimelineSections(updated, sections);
    expect(next[0]!.key).toBe(sections[0]!.key);
    expect(updated[0]!.key).toBe(initial[0]!.key);
  });

  it('preserves both sides of a same-turn steering boundary when prepending', () => {
    const tail: ThreadItem[] = [
      { ...agent('progress'), turnId: 't' },
      { type: 'userMessage', id: 'steer', turnId: 't', content: [] },
      { ...agent('answer'), turnId: 't' }
    ];
    const initial = buildTimelineSections(buildTimelineEntries(tail));
    const next = buildTimelineSections(buildTimelineEntries([{ ...command('first'), turnId: 't' }, ...tail]), initial);
    expect(next.map(section => section.key)).toEqual(initial.map(section => section.key));
    expect(new Set(next.map(section => section.key)).size).toBe(3);
  });

  it('reuses unchanged responses when paging or streaming in another turn', () => {
    const earlier: ThreadItem = { ...agent('earlier'), turnId: 'old' };
    const latest: ThreadItem = { ...agent('latest'), turnId: 'new' };
    const initialEntries = buildTimelineEntries([earlier, latest]);
    const initial = buildTimelineSections(initialEntries);
    const entries = buildTimelineEntries([earlier, { ...latest, text: 'Streaming' }], 'new', initialEntries);
    const sections = buildTimelineSections(entries, initial);
    expect(sections[0]).toBe(initial[0]);
    expect(sections[1]).not.toBe(initial[1]);
    const prefixed = buildTimelineEntries([{ ...agent('prefix'), turnId: 'older' }, earlier, latest], null, initialEntries);
    expect(buildTimelineSections(prefixed, initial).slice(1)).toEqual(initial);
    expect(buildTimelineSections(prefixed, initial)[1]).toBe(initial[0]);
  });
});
