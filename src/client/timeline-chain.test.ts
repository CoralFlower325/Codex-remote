import { describe, expect, it } from 'vitest';
import {
  buildTimelineEntries, buildTimelineSections, projectTimeline,
  type TimelineChainCache, type TimelineSection
} from './timeline-model';
import type { ThreadItem } from './types';

/**
 * The incremental chain is pinned to the full builders: every step of
 * every mutation sequence must produce deep-equal entries and sections
 * (keys included) to the legacy two-builder chain fed with its own
 * previous output, exactly as ThreadTimeline wired it before.
 */
class ChainHarness {
  private legacySections: TimelineSection[] = [];
  private cache: TimelineChainCache | null = null;

  step(items: ThreadItem[], activeTurnId: string | null = null): void {
    // Callers hand over an immutable snapshot per step, exactly like
    // React state: the array identity must change when its content does.
    const snapshot = [...items];
    const legacyEntries = buildTimelineEntries(snapshot, activeTurnId,
      this.legacySections.flatMap(section => section.entries));
    const legacyNext = buildTimelineSections(legacyEntries, this.legacySections);
    this.legacySections = legacyNext;
    const projected = projectTimeline(snapshot, activeTurnId, this.cache);
    this.cache = projected.cache;
    expect(projected.entries.map(entry => entry.key)).toEqual(legacyEntries.map(entry => entry.key));
    expect(projected.entries).toEqual(legacyEntries);
    expect(projected.sections.map(section => section.key)).toEqual(legacyNext.map(section => section.key));
    expect(projected.sections).toEqual(legacyNext);
  }
}

const user = (turnId: string, id: string, text = `问题 ${id}`): ThreadItem =>
  ({ turnId, type: 'userMessage', id, content: [{ type: 'text', text }] } as ThreadItem);
const agent = (turnId: string, id: string, text: string, phase: 'commentary' | 'final_answer' = 'commentary'): ThreadItem =>
  ({ turnId, type: 'agentMessage', id, phase, text } as ThreadItem);
const cmd = (turnId: string, id: string, status = 'completed'): ThreadItem =>
  ({ turnId, type: 'commandExecution', id, status, command: 'npm test', aggregatedOutput: 'ok' } as ThreadItem);

describe('incremental timeline chain equivalence', () => {
  it('matches the full builders while a mega turn streams appends and tail growth', () => {
    const harness = new ChainHarness();
    const items: ThreadItem[] = [user('tmega', 'umega')];
    harness.step(items, 'tmega');
    for (let round = 0; round < 30; round++) {
      for (let i = 0; i < 40; i++) items.push(cmd('tmega', `cm-${round * 40 + i}`));
      harness.step(items, 'tmega');
      if (round % 6 === 5) {
        items.push(agent('tmega', `note-${round}`, `阶段说明 ${round}`));
        harness.step(items, 'tmega');
      }
    }
    // Tail growth: the growing final answer is replaced in place.
    items.push(agent('tmega', 'final', '最终答复', 'final_answer'));
    harness.step(items, 'tmega');
    for (let i = 0; i < 12; i++) {
      const tail = items[items.length - 1]!;
      items[items.length - 1] = { ...tail, text: `${(tail as { text: string }).text}。` } as ThreadItem;
      harness.step(items, 'tmega');
    }
    // Command output growth replaces a command item inside the tail turn.
    const commandIndex = items.findIndex(item => item.id === 'cm-1190');
    items[commandIndex] = { ...items[commandIndex]!, aggregatedOutput: 'ok\nmore output' } as ThreadItem;
    harness.step(items, 'tmega');
    harness.step(items, null);
  });

  it('matches while ordinary turns append one by one', () => {
    const harness = new ChainHarness();
    const items: ThreadItem[] = [];
    for (let turn = 0; turn < 40; turn++) {
      items.push(user(`lt${turn}`, `lu${turn}`));
      harness.step(items);
      for (let i = 0; i < 8; i++) items.push(cmd(`lt${turn}`, `lc${turn}-${i}`));
      harness.step(items);
      items.push(agent(`lt${turn}`, `la${turn}`, `结论 ${turn}。`, 'final_answer'));
      harness.step(items);
    }
  });

  it('matches across prepends, trims and mid-list growth (full-rebuild shapes)', () => {
    const harness = new ChainHarness();
    let items: ThreadItem[] = [];
    for (let turn = 20; turn < 30; turn++) {
      items.push(user(`t${turn}`, `u${turn}`), cmd(`t${turn}`, `c${turn}`),
        agent(`t${turn}`, `a${turn}`, `答复 ${turn}。`, 'final_answer'));
    }
    harness.step(items);
    // Prepend an older page (head change).
    const older: ThreadItem[] = [];
    for (let turn = 10; turn < 20; turn++) {
      older.push(user(`t${turn}`, `u${turn}`), cmd(`t${turn}`, `c${turn}`),
        agent(`t${turn}`, `a${turn}`, `答复 ${turn}。`, 'final_answer'));
    }
    items = [...older, ...items];
    harness.step(items);
    // An initially skipped empty message grows content mid-list.
    const emptyIndex = items.findIndex(item => item.id === 'a15');
    items[emptyIndex] = agent('t15', 'a15', '');
    harness.step(items);
    items[emptyIndex] = agent('t15', 'a15', '迟到的正文。');
    harness.step(items);
    // Window trim from the head and from the tail.
    items = items.slice(15);
    harness.step(items);
    items = items.slice(0, items.length - 9);
    harness.step(items);
    // Active turn flips without any item change.
    harness.step(items, 't25');
    harness.step(items, null);
  });

  it('matches a mixed stream with subagents, images, searches and skipped items', () => {
    const harness = new ChainHarness();
    const items: ThreadItem[] = [user('tx', 'ux')];
    harness.step(items, 'tx');
    items.push({ turnId: 'tx', type: 'reasoning', id: 'r1', summary: [], content: [] } as ThreadItem);
    items.push({ turnId: 'tx', type: 'webSearch', id: 'ws1', query: '' } as ThreadItem);
    harness.step(items, 'tx');
    items.push({ turnId: 'tx', type: 'webSearch', id: 'ws1', query: '远程 滑动' } as ThreadItem);
    items[items.length - 1] = { turnId: 'tx', type: 'webSearch', id: 'ws1', query: '远程 滑动' } as ThreadItem;
    harness.step(items, 'tx');
    items.push({ turnId: 'tx', type: 'collabAgentToolCall', id: 'sub1' } as ThreadItem);
    items.push(cmd('tx', 'cx1'));
    items.push({ turnId: 'tx', type: 'subAgentActivity', id: 'sub2' } as ThreadItem);
    items.push(cmd('tx', 'cx2'));
    harness.step(items, 'tx');
    items.push({ turnId: 'tx', type: 'imageView', id: 'iv1', path: '/tmp/a.png' } as ThreadItem);
    items.push(cmd('tx', 'cx3'));
    harness.step(items, 'tx');
    items.push(agent('tx', 'final', '完成。', 'final_answer'));
    harness.step(items, 'tx');
    harness.step(items, null);
  });

  it('matches a seeded random mutation sequence', () => {
    for (const initialSeed of [0x2f6e2b1, 0x1a2b3c4]) runSeededSequence(initialSeed);
  });
});

function runSeededSequence(initialSeed: number) {
    // Deterministic LCG so failures reproduce exactly.
    let seed = initialSeed;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const harness = new ChainHarness();
    let items: ThreadItem[] = [];
    let counter = 0;
    let currentTurn = 'fz0';
    const freshItem = (): ThreadItem => {
      const id = `fz-${counter++}`;
      const pick = random();
      if (pick < 0.12) {
        currentTurn = `fz${counter}`;
        return user(currentTurn, id);
      }
      if (pick < 0.4) return agent(currentTurn, id, `正文 ${id}`, random() < 0.3 ? 'final_answer' : 'commentary');
      if (pick < 0.75) return cmd(currentTurn, id, random() < 0.1 ? 'failed' : 'completed');
      if (pick < 0.82) return { turnId: currentTurn, type: 'fileChange', id, changes: [] } as unknown as ThreadItem;
      if (pick < 0.88) return { turnId: currentTurn, type: 'mcpToolCall', id, status: 'completed' } as unknown as ThreadItem;
      if (pick < 0.94) return { turnId: currentTurn, type: 'imageView', id, path: '/tmp/x.png' } as unknown as ThreadItem;
      return { turnId: currentTurn, type: 'collabAgentToolCall', id } as unknown as ThreadItem;
    };
    for (let stepIndex = 0; stepIndex < 300; stepIndex++) {
      const action = random();
      if (action < 0.55 || items.length === 0) {
        const batch = 1 + Math.floor(random() * 30);
        for (let i = 0; i < batch; i++) items.push(freshItem());
      } else if (action < 0.8) {
        // Replace a random item in the tail half (streaming growth shape).
        const index = items.length - 1 - Math.floor(random() * Math.max(1, Math.floor(items.length / 2)));
        const old = items[index]!;
        items[index] = { ...old } as ThreadItem;
      } else if (action < 0.88) {
        // Replace a random item anywhere (snapshot reorder/growth shape).
        const index = Math.floor(random() * items.length);
        items[index] = freshItem();
      } else if (action < 0.94 && items.length > 40) {
        items = items.slice(Math.floor(random() * 20));
      } else {
        items = [...items.slice(items.length - 30), ...items];
      }
      harness.step([...items], random() < 0.4 ? currentTurn : null);
    }
}
