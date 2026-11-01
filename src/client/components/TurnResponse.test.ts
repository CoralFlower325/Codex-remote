import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponseSection } from './TurnResponse';
import { buildTimelineEntries, buildTimelineSections } from '../timeline-model';
import type { ThreadItem } from '../types';
import type { TurnTiming } from '../../shared/turn-timing';

const items: ThreadItem[] = [
  { type: 'commandExecution', id: 'command', turnId: 'turn', command: 'echo synthetic',
    cwd: '/project', status: 'completed', aggregatedOutput: 'Synthetic output', exitCode: 0, durationMs: 100 },
  { type: 'agentMessage', id: 'answer', turnId: 'turn', phase: 'final_answer',
    text: 'Native final answer', startedAtMs: null, completedAtMs: null }
];
const section = buildTimelineSections(buildTimelineEntries(items, null))[0]!;
const timing: TurnTiming = { id: 'turn', status: 'completed', startedAt: 1,
  completedAt: 5, durationMs: 4000 };
const render = (threadIdle: boolean, timing: TurnTiming | undefined, active = false) =>
  renderToStaticMarkup(createElement(ResponseSection, {
    section, timing, threadIdle, finalStartedAtMs: null, hasTrace: true, showError: false, open: false, active,
    onToggleTurn: () => {}, onInteract: () => {}, onFork: undefined, onError: undefined
  }));

describe('first conversation paint before turn timings', () => {
  it('keeps timestamp-free final-answer process folded when native metadata confirms an idle thread', () => {
    const before = render(true, undefined);
    const after = render(true, timing);
    for (const html of [before, after]) {
      expect(html).toContain('Native final answer');
      expect(html).toContain('class="worked-divider"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('class="turn-activity"');
      expect(html).not.toContain('echo synthetic');
    }
  });
  it('keeps a streamed final-answer process visible while native status is active or unknown', () => {
    expect(render(false, undefined)).toContain('class="turn-activity"');
    expect(render(true, undefined, true)).toContain('class="turn-activity"');
    expect(render(true, { ...timing, status: 'inProgress' })).toContain('class="turn-activity"');
  });
});
