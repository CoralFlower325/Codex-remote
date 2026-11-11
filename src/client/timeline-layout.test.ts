import { describe, expect, it } from 'vitest';
import {
  buildTimelineEntries, buildTimelineSections, finalAnswerIndex, timelineTurnResponses,
  type TimelineSection
} from './timeline-model';
import {
  createTimelineLayoutCache, estimateLayoutRowHeight, projectLayoutRows,
  sectionRendersFolded, turnIsCompleted, type TimelineLayoutContext
} from './timeline-layout';
import type { TurnTiming } from '../shared/turn-timing';
import type { ThreadItem } from './types';

const user = (turnId: string, id: string, text = `问题 ${id}`): ThreadItem =>
  ({ turnId, type: 'userMessage', id, content: [{ type: 'text', text }] } as ThreadItem);
const agent = (turnId: string, id: string, text: string, phase: 'commentary' | 'final_answer' = 'commentary'): ThreadItem =>
  ({ turnId, type: 'agentMessage', id, phase, text } as ThreadItem);
const cmd = (turnId: string, id: string): ThreadItem =>
  ({ turnId, type: 'commandExecution', id, status: 'completed', command: 'npm test', aggregatedOutput: 'ok' } as ThreadItem);
const subagent = (turnId: string, id: string): ThreadItem =>
  ({ turnId, type: 'collabAgentToolCall', id, tool: 'spawnAgent', status: 'completed',
    receiverThreadIds: ['child-1'] } as unknown as ThreadItem);

const timing = (id: string, error = false): TurnTiming => ({
  id, status: 'completed', startedAt: 100, completedAt: 160, durationMs: 60000,
  ...(error ? { error: { message: '原生错误文本', codexErrorInfo: 'other' } as TurnTiming['error'] } : {})
} as TurnTiming);

function sectionsOf(items: ThreadItem[]): TimelineSection[] {
  return buildTimelineSections(buildTimelineEntries(items, null, []), []);
}

function contextOf(sections: TimelineSection[], overrides: Partial<TimelineLayoutContext> = {}): TimelineLayoutContext {
  const turnIds = [...new Set(sections.map(section => section.turnId).filter(Boolean))] as string[];
  return {
    expandedTurns: new Set(),
    activeTurnId: null,
    threadIdle: true,
    turnTimings: Object.fromEntries(turnIds.map(id => [id, timing(id)])),
    responses: timelineTurnResponses(sections),
    ...overrides
  };
}

/** A steered giant turn, shaped like the acceptance fixture. */
function steeredTurn(steers: number, turnId = 'tmega'): ThreadItem[] {
  const items: ThreadItem[] = [user(turnId, 'umega', '把远程版本一路收齐并部署')];
  const steerBefore = new Set(Array.from({ length: steers }, (_, k) =>
    Math.floor((k + 1) * 30 / (steers + 1))));
  for (let i = 0; i < 30; i++) {
    if (steerBefore.has(i)) {
      items.push(user(turnId, `usteer-${i}`, `插话 ${i}：先确认一下这一步的结果`));
    }
    items.push(cmd(turnId, `cm-${i}`));
  }
  items.push(agent(turnId, 'amega', '最终答复标记 MEGA-FINAL', 'final_answer'));
  return items;
}

describe('layout projection of a folded steered turn', () => {
  it('drops the trace-only mid-turn sections and keeps divider, steer and final rows', () => {
    const sections = sectionsOf(steeredTurn(3));
    // Model shape: user + 4 response sections (3 steers), 3 steer users.
    expect(sections.filter(section => !section.user)).toHaveLength(4);
    const context = contextOf(sections);
    const { rows } = projectLayoutRows(sections, context, createTimelineLayoutCache());
    const responseRows = rows.filter(row => !row.section.user);
    // Exactly the divider section and the final-answer section survive.
    expect(responseRows.map(row => row.section.key)).toEqual([
      sections.find(section => section.showTiming)!.key,
      sections[sections.length - 1]!.key
    ]);
    // Every surviving row renders content in the folded state.
    for (const row of rows) {
      expect(sectionRendersFolded(row.section,
        context.responses.get('tmega')?.lastResponseKey === row.section.key &&
          context.turnTimings['tmega']?.error != null)).toBe(true);
    }
    // No row is a known-empty row: folded content test per row section.
    const empty = rows.filter(row => !row.section.user && !row.section.showTiming &&
      finalAnswerIndex(row.section.entries) < 0);
    expect(empty).toHaveLength(0);
  });

  it('folded response row count does not grow with the steering count', () => {
    for (const steers of [0, 1, 3, 6]) {
      const sections = sectionsOf(steeredTurn(steers));
      const { rows } = projectLayoutRows(sections, contextOf(sections), createTimelineLayoutCache());
      // With no steers the divider and the final answer share one
      // section; with any steers they are two rows — never more.
      expect(rows.filter(row => !row.section.user)).toHaveLength(steers === 0 ? 1 : 2);
      // User rows = the question plus one per steer (all real content).
      expect(rows.filter(row => row.section.user)).toHaveLength(1 + steers);
    }
  });

  it('projects every section when the turn is expanded or active', () => {
    const sections = sectionsOf(steeredTurn(3));
    const expanded = contextOf(sections, { expandedTurns: new Set(['tmega']) });
    expect(projectLayoutRows(sections, expanded, createTimelineLayoutCache()).rows).toHaveLength(sections.length);
    const active = contextOf(sections, { activeTurnId: 'tmega' });
    expect(projectLayoutRows(sections, active, createTimelineLayoutCache()).rows).toHaveLength(sections.length);
  });

  it('keeps mid-turn sections that render outside the fold: subagents, local finals, errors', () => {
    const items: ThreadItem[] = [
      user('t1', 'u1'),
      cmd('t1', 'c1'),                                    // R1: divider section
      user('t1', 'u2', '插话'),
      cmd('t1', 'c2'), subagent('t1', 'sa1'), cmd('t1', 'c3'), // R2: subagent rows
      user('t1', 'u3', '再插一句'),
      cmd('t1', 'c4'),
      agent('t1', 'mid-final', '中段的局部结论', 'final_answer'), // R3: local final
      cmd('t1', 'c5'),
      user('t1', 'u4', '最后一句'),
      cmd('t1', 'c6'),                                    // R4: trace only — dropped
      user('t1', 'u5', '收尾'),
      cmd('t1', 'c7'),
      agent('t1', 'fin', '最终答复', 'final_answer')       // R5: final answer
    ];
    const sections = sectionsOf(items);
    expect(sections.filter(section => !section.user)).toHaveLength(5);
    const context = contextOf(sections);
    const { rows } = projectLayoutRows(sections, context, createTimelineLayoutCache());
    const responseRows = rows.filter(row => !row.section.user);
    // R1 (divider), R2 (subagent), R3 (local final) and R5 (final)
    // survive; only the trace-only R4 is projected away.
    const flatIds = (section: TimelineSection) => section.entries.flatMap(entry =>
      entry.type === 'activity' ? entry.items.map(item => item.id) : [entry.item.id]);
    expect(responseRows.map(row => row.section.key)).toEqual(
      sections.filter(section => !section.user)
        .filter(section => flatIds(section).join() !== 'c6')
        .map(section => section.key));
  });

  it('keeps the error-carrying last section even when it has no final answer', () => {
    const items: ThreadItem[] = [
      user('t1', 'u1'), cmd('t1', 'c1'),
      user('t1', 'u2', '插话'), cmd('t1', 'c2')
    ];
    const sections = sectionsOf(items);
    const context = contextOf(sections, { turnTimings: { t1: timing('t1', true) } });
    const { rows } = projectLayoutRows(sections, context, createTimelineLayoutCache());
    // Last response section carries the native error: it stays a row.
    expect(rows.filter(row => !row.section.user).map(row => row.section.key)).toEqual(
      sections.filter(section => !section.user).map(section => section.key));
  });
});

describe('visible-text equivalence between projection and full section list', () => {
  /** What a reader can actually read, derived from ResponseSection's
   * branches: user text always; folded turns show the divider marker,
   * subagent rows, the answer slice from the final answer on, and the
   * native error; open/live turns show every message in order. */
  function visibleText(sections: TimelineSection[], context: TimelineLayoutContext): string[] {
    const out: string[] = [];
    for (const section of sections) {
      if (section.user) {
        const item = section.entries[0]?.type === 'message' ? section.entries[0].item : undefined;
        out.push(`U:${item?.type === 'userMessage' ? item.content[0]?.text ?? '' : ''}`);
        continue;
      }
      const turnId = section.turnId!;
      const completed = turnIsCompleted(turnId, context);
      const open = context.expandedTurns.has(turnId);
      const showError = context.responses.get(turnId)?.lastResponseKey === section.key &&
        context.turnTimings[turnId]?.error != null;
      if (!completed || open) {
        if (section.showTiming) out.push('D');
        for (const entry of section.entries) {
          if (entry.type === 'message') out.push(`M:${entry.item.type === 'agentMessage' ? entry.item.text : ''}`);
          else if (entry.type === 'activity') out.push(`A:${entry.items.length}`);
          else out.push('E');
        }
        if (showError) out.push('ERR');
        continue;
      }
      if (section.showTiming) out.push('D');
      if (section.entries.some(entry => entry.type === 'event')) out.push('S');
      const finalIndex = finalAnswerIndex(section.entries);
      if (finalIndex >= 0) {
        for (const entry of section.entries.slice(finalIndex)) {
          if (entry.type === 'message') out.push(`M:${entry.item.type === 'agentMessage' ? entry.item.text : ''}`);
          else if (entry.type === 'activity') out.push(`A:${entry.items.length}`);
        }
        out.push('R'); // reply actions
      }
      if (showError) out.push('ERR');
    }
    return out;
  }

  it('matches in folded and expanded states, with no drops or duplicates', () => {
    const items: ThreadItem[] = [
      user('t0', 'u0', '较早的问题'), cmd('t0', 'c0'), agent('t0', 'a0', '较早的结论', 'final_answer'),
      ...steeredTurn(3),
      user('t2', 'u9', '最后一个问题'), cmd('t2', 'c9'), agent('t2', 'a9', '最后的结论', 'final_answer')
    ];
    const sections = sectionsOf(items);
    for (const expanded of [new Set<string>(), new Set(['tmega'])]) {
      const context = contextOf(sections, { expandedTurns: expanded });
      const { rows } = projectLayoutRows(sections, context, createTimelineLayoutCache());
      const projectedSections = rows.map(row => row.section);
      expect(visibleText(projectedSections, context)).toEqual(visibleText(sections, context));
      // sectionIndex always points back at the section's own position.
      for (const row of rows) expect(sections[row.sectionIndex]).toBe(row.section);
    }
  });
});

describe('per-turn projection cache', () => {
  it('reuses row objects for untouched turns across a prepend and a foreign toggle', () => {
    const older: ThreadItem[] = [user('t0', 'u0'), cmd('t0', 'c0'), agent('t0', 'a0', '结论', 'final_answer')];
    const base = sectionsOf([...steeredTurn(2), user('t2', 'u9'), agent('t2', 'a9', '结论', 'final_answer')]);
    const cache = createTimelineLayoutCache();
    const first = projectLayoutRows(base, contextOf(base), cache);
    const grown = sectionsOf([...older, ...steeredTurn(2), user('t2', 'u9'), agent('t2', 'a9', '结论', 'final_answer')]);
    // A prepend rebuilds section objects for the boundary turn only in
    // the chain; here we simulate the projection-level contract with
    // fresh objects for the new turn and identical ones elsewhere.
    const remapped = grown.map(section =>
      base.find(candidate => candidate.key === section.key) ?? section);
    const second = projectLayoutRows(remapped, contextOf(remapped), first.cache);
    const firstByKey = new Map(first.rows.map(row => [row.key, row]));
    for (const row of second.rows) {
      if (row.section.turnId === 't0') continue; // the new turn: fresh rows
      expect(row).toBe(firstByKey.get(row.key));
    }
    // Toggling a different turn leaves this turn's rows identical.
    const toggled = projectLayoutRows(remapped,
      contextOf(remapped, { expandedTurns: new Set(['t2']) }), second.cache);
    const secondByKey = new Map(second.rows.map(row => [row.key, row]));
    for (const row of toggled.rows) {
      if (row.section.turnId === 't2') continue;
      expect(row).toBe(secondByKey.get(row.key));
    }
  });
});

describe('structural row estimates', () => {
  it('prices a one-line user row and a divider-only folded row near their measured sizes', () => {
    const sections = sectionsOf(steeredTurn(0));
    const userSection = sections.find(section => section.user)!;
    const userEstimate = estimateLayoutRowHeight(userSection, { expanded: false, completed: true, showError: false });
    expect(userEstimate).toBeGreaterThan(110);
    expect(userEstimate).toBeLessThan(135);
    // A divider section whose final answer lives in a later section
    // (steered shape) prices at margin + divider alone.
    const steered = sectionsOf(steeredTurn(1));
    const divider = steered.find(section => section.showTiming)!;
    const dividerEstimate = estimateLayoutRowHeight(divider, { expanded: false, completed: true, showError: false });
    expect(dividerEstimate).toBeGreaterThan(55);
    expect(dividerEstimate).toBeLessThan(85);
  });

  it('grows with answer length and with expansion instead of flat constants', () => {
    const short = sectionsOf([user('t', 'u'), agent('t', 'a', '短答复', 'final_answer')]);
    const longText = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段正文内容，用来撑起一个较长的最终答复。`).join('\n\n');
    const long = sectionsOf([user('t', 'u'), agent('t', 'a', longText, 'final_answer')]);
    const seed = (sections: TimelineSection[], expanded: boolean) => estimateLayoutRowHeight(
      sections.find(section => !section.user)!, { expanded, completed: true, showError: false });
    expect(seed(long, false)).toBeGreaterThan(seed(short, false) + 200);
    const trace = sectionsOf(steeredTurn(0));
    expect(seed(trace, true)).toBeGreaterThan(seed(trace, false));
  });
});
