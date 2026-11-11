import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponseSection } from './TurnResponse';
import { buildTimelineEntries, buildTimelineSections } from '../timeline-model';
import type { ThreadItem } from '../types';
import type { TurnTiming } from '../../shared/turn-timing';

// Interleave commands and commentary so the trace holds many entries
// (consecutive commands would fold into a single activity entry).
const traceItems = (count: number): ThreadItem[] => {
  const items: ThreadItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({ type: 'commandExecution', id: `cmd-${i}`, turnId: 'turn', command: `echo step-${i}`,
      cwd: '/project', status: 'completed', aggregatedOutput: 'ok', exitCode: 0, durationMs: 10 });
    items.push({ type: 'agentMessage', id: `note-${i}`, turnId: 'turn', phase: 'commentary',
      text: `阶段说明 ${i}`, startedAtMs: null, completedAtMs: null });
  }
  return items;
};

const render = (items: ThreadItem[], active: boolean, timing: TurnTiming, open = false) => {
  const section = buildTimelineSections(buildTimelineEntries(items, active ? 'turn' : null))[0]!;
  return renderToStaticMarkup(createElement(ResponseSection, {
    section, timing, threadIdle: !active, finalStartedAtMs: null, hasTrace: true, showError: false, open, active,
    onToggleTurn: () => {}, onInteract: () => {}, onFork: undefined, onError: undefined
  }));
};

const inProgress: TurnTiming = { id: 'turn', status: 'inProgress', startedAt: 1, completedAt: null, durationMs: null };
const completed: TurnTiming = { id: 'turn', status: 'completed', startedAt: 1, completedAt: 5, durationMs: 4000 };

describe('active-turn trace windowing', () => {
  it('folds the head of an over-long streaming trace and keeps the tail mounted', () => {
    const html = render(traceItems(250), true, inProgress);
    // 500 entries, window 200: the first 300 entries fold behind the
    // same "show earlier" language the activity groups use.
    expect(html).toContain('显示更早的记录（300）');
    expect(html).toContain('阶段说明 150');
    expect(html).toContain('阶段说明 249');
    expect(html).not.toContain('阶段说明 149');
    expect(html).not.toContain('阶段说明 0');
  });

  it('renders the whole trace when it fits the window', () => {
    const html = render(traceItems(75), true, inProgress);
    expect(html).not.toContain('显示更早的记录');
    expect(html).toContain('阶段说明 0');
    expect(html).toContain('阶段说明 74');
  });

  it('never folds a completed turn: its full trace stays under the disclosure', () => {
    const items: ThreadItem[] = [...traceItems(250),
      { type: 'agentMessage', id: 'answer', turnId: 'turn', phase: 'final_answer',
        text: 'Native final answer', startedAtMs: null, completedAtMs: 2 }];
    const html = render(items, false, completed, true);
    expect(html).not.toContain('显示更早的记录');
    expect(html).toContain('阶段说明 0');
    expect(html).toContain('阶段说明 249');
    expect(html).toContain('Native final answer');
  });
});
