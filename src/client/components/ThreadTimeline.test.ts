import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ThreadTimeline } from './ThreadTimeline';
import type { ThreadItem } from '../types';
import { mergeTurnTimings } from '../remote-state';
import type { TurnTiming } from '../../shared/turn-timing';

const complete: TurnTiming = { id: 't', status: 'completed', startedAt: 100, completedAt: 1113, durationMs: 1_013_000 };
const render = (items: ThreadItem[], turnTimings: Record<string, TurnTiming> = {}) => renderToStaticMarkup(createElement(ThreadTimeline, {
  threadId: 'thread', items, activeTurnId: null, turnTimings, loading: false, hasMoreHistory: false,
  loadingHistory: false, onLoadEarlier: async () => {}
}));
const command: ThreadItem = { type: 'commandExecution', id: 'cmd', turnId: 't', command: 'echo detail',
  cwd: '/project', status: 'completed', aggregatedOutput: 'detail', durationMs: 100, exitCode: 0 };

describe('conversation presentation', () => {
  it('shows full user context in history navigation without a show-more button', () => {
    const text = '完整上下文'.repeat(250) + 'VISIBLE_END';
    const html = renderToStaticMarkup(createElement(ThreadTimeline, {
      threadId: 'thread', items: [{ type: 'userMessage', id: 'u', turnId: 't', content: [{ type: 'text', text }] }],
      loading: false, activeTurnId: null, turnTimings: {}, hasMoreHistory: true, loadingHistory: false,
      viewingHistory: true, hasNewerHistory: true, onLoadEarlier: async () => {}, onLoadLater: async () => {}
    }));
    expect(html).toContain('VISIBLE_END');
    expect(html).not.toContain('展开消息');
    expect(html).not.toContain('显示后续记录');
  });
  it('folds completed process and commentary, keeps the request/final visible, and uses native duration', () => {
    const html = render([
      { type: 'userMessage', id: 'u', turnId: 't', content: [{ type: 'text', text: 'VISIBLE_REQUEST' }] },
      { type: 'agentMessage', id: 'p', turnId: 't', phase: 'commentary', text: 'HIDDEN_PROGRESS' },
      command,
      { type: 'agentMessage', id: 'a', turnId: 't', phase: 'final_answer', text: 'VISIBLE_ANSWER' }
    ], { t: complete });
    expect(html).toContain('VISIBLE_REQUEST');
    expect(html).toContain('VISIBLE_ANSWER');
    expect(html).toContain('用时 16分钟 53秒');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('HIDDEN_PROGRESS');
    expect(html).not.toContain('echo detail');
  });

  it('shows timing when the latest history page does not contain the original user message', () => {
    const html = render([{ type: 'agentMessage', id: 'a', turnId: 't', phase: 'final_answer', text: 'ANSWER' }], { t: complete });
    expect(html).toContain('用时 16分钟 53秒');
    expect(html).toContain('ANSWER');
  });
  it('keeps the final reply and its timing anchor visible before an empty asynchronous question', () => {
    const html = render([
      { type: 'agentMessage', id: 'a', turnId: 't', phase: 'final_answer', text: 'VISIBLE_FINAL',
        startedAtMs: 147_250 },
      { type: 'agentMessage', id: 'q', turnId: 't', delivery: 'async', text: '', startedAtMs: 200_000,
        questions: [{ title: 'Choose?', options: ['A', 'B'] }] }
    ], { t: complete });
    expect(html).toContain('VISIBLE_FINAL');
    expect(html).toContain('用时 47秒');
    expect(html).not.toContain('用时 1分钟 40秒');
  });

  it('uses the saved final-answer start instead of counting the time spent generating that answer', () => {
    const html = render([
      { type: 'agentMessage', id: 'a', turnId: 't', phase: 'final_answer', text: 'ANSWER',
        startedAtMs: 147_250, completedAtMs: 1_113_000 }
    ], { t: complete });
    expect(html).toContain('用时 47秒');
    expect(html).not.toContain('16分钟');
  });

  it('freezes the work divider while a final answer is still streaming', () => {
    const html = renderToStaticMarkup(createElement(ThreadTimeline, {
      threadId: 'thread',
      items: [{ type: 'agentMessage', id: 'a', turnId: 't', phase: 'final_answer', text: 'PARTIAL',
        startedAtMs: 147_250 }],
      activeTurnId: 't', turnTimings: { t: { ...complete, status: 'inProgress', completedAt: null, durationMs: null } },
      loading: false, hasMoreHistory: false, loadingHistory: false, onLoadEarlier: async () => {}
    }));
    expect(html).toContain('用时 47秒');
    expect(html).not.toContain('已处理');
    expect(html).toContain('PARTIAL');
  });

  it('combines mixed operations without reasoning rows or command-count noise', () => {
    const html = render([
      command,
      { type: 'reasoning', id: 'r', turnId: 't', summary: ['PRIVATE_REASONING'], content: [] },
      { type: 'fileChange', id: 'f', turnId: 't', status: 'completed', changes: [] },
      { type: 'webSearch', id: 's', turnId: 't', query: 'native protocol' }
    ]);
    expect(html.match(/class="activity-group-toggle"/g)).toHaveLength(1);
    expect(html).toContain('编辑了文件、运行了命令、已搜索网页');
    expect(html).not.toContain('PRIVATE_REASONING');
    expect(html).not.toContain('条命令');
  });

  it('keeps timing notifications that arrive while history is loading without retaining unchanged stale turns', () => {
    const running = { ...complete, status: 'inProgress' as const, completedAt: null, durationMs: null };
    const baseline = { t: running, old: { ...running, id: 'old' } };
    const updated = { ...baseline, t: complete };
    const oldFinished = { ...complete, id: 'old' };
    expect(mergeTurnTimings(updated, [running, oldFinished], baseline)).toEqual({ t: complete, old: oldFinished });
  });

  it('provides user anchors and an outline independent of the currently loaded history window', () => {
    const html = renderToStaticMarkup(createElement(ThreadTimeline, {
      threadId: 'thread', items: [{ type: 'userMessage', id: 'u', turnId: 't', content: [{ type: 'text', text: 'Latest' }] }],
      activeTurnId: null, turnTimings: { t: complete }, loading: false, hasMoreHistory: true,
      loadingHistory: false, onLoadEarlier: async () => {},
      outlineTurns: [{ ...complete, messages: [
        { itemId: 'old-user', prompt: 'Earlier request', reply: 'Earlier reply' },
        { itemId: 'u', prompt: 'Latest', reply: '' }
      ] }]
    }));
    expect(html).toContain('data-user-key="[&quot;t&quot;,&quot;u&quot;]"');
    expect(html).toContain('aria-label="第 1 轮：Earlier request"');
    expect(html).toContain('aria-label="第 2 轮：Latest"');
    expect(html.match(/class="thread-navigation-mark/g)).toHaveLength(2);
  });
});
