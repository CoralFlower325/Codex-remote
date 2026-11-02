import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { collectSubagents, subagentChatStatus, subagentSource } from './subagents';
import { ThreadTimeline } from './components/ThreadTimeline';
import { SubagentsContext } from './components/Subagents';
import type { Thread, ThreadItem } from './types';

const spawn: ThreadItem = { type: 'collabAgentToolCall', id: 'spawn', turnId: 't', tool: 'spawnAgent',
  status: 'completed', senderThreadId: 'parent', receiverThreadIds: ['child'], prompt: 'Inspect loading',
  model: 'native-model', reasoningEffort: 'high', agentsStates: { child: { status: 'running', message: null } } };
const child: Thread = { id: 'child', name: null, preview: '', cwd: '/workspace', projectId: null,
  model: 'native-model', modelProvider: 'native', reasoningEffort: 'high', createdAt: 1, updatedAt: 2,
  status: { type: 'idle' }, agentNickname: 'Atlas', agentRole: 'explorer',
  source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_path: '/root/loading' } } } };

describe('native subagent presentation', () => {
  it('uses the newest native child turn rather than the insertion order of history metadata', () => {
    expect(subagentChatStatus({ activeTurnId: null, agent: { threadId: 'child', name: 'Atlas', status: 'running' },
      timings: { new: { id: 'new', startedAt: 200, status: 'failed', durationMs: 1000, completedAt: 201 },
        old: { id: 'old', startedAt: 100, status: 'completed', durationMs: 1000, completedAt: 101 } } })).toBe('errored');
    expect(subagentChatStatus({ activeTurnId: 'resumed', agent: { threadId: 'child', name: 'Atlas', status: 'shutdown' },
      timings: {} })).toBe('running');
  });
  it('uses native receiver IDs and latest agent state, not the spawn tool completion status', () => {
    expect(collectSubagents([spawn], [child])).toMatchObject([{ threadId: 'child', name: 'Atlas',
      role: 'explorer', status: 'running', model: 'native-model', effort: 'high' }]);
    const wait: ThreadItem = { ...spawn, id: 'wait', tool: 'wait', receiverThreadIds: [],
      agentsStates: { child: { status: 'completed', message: 'Finished' }, second: { status: 'errored', message: 'Failed' } } };
    expect(collectSubagents([spawn, wait], [child])).toMatchObject([
      { threadId: 'child', status: 'completed' }, { threadId: 'second', status: 'errored' }
    ]);
  });
  it('merges native activity and tool records for the same child, including nested paths', () => {
    expect(collectSubagents([spawn, { type: 'subAgentActivity', id: 'done', turnId: 't',
      kind: 'completed', agentThreadId: 'child', agentPath: '/root/loading',
      model: null, reasoningEffort: null }])).toMatchObject([{ name: 'loading', status: 'completed' }]);
  });
  it('discovers children beyond the current history window without including other parents or review/compact helpers', () => {
    expect(subagentSource({ ...child, source: { subAgent: 'review' } })).toBeNull();
    expect(collectSubagents([], [child, { ...child, id: 'other', source: 'appServer' }], 'parent'))
      .toMatchObject([{ threadId: 'child', name: 'Atlas' }]);
    expect(collectSubagents([], [child], 'unrelated')).toEqual([]);
  });
  it('keeps one clickable child entrance after the completed process folds, and never exposes the delegated prompt as reply text', () => {
    const html = renderToStaticMarkup(createElement(SubagentsContext.Provider, { value: { threads: [child], open: () => {} } },
      createElement(ThreadTimeline, { threadId: 'parent', items: [spawn, { ...spawn, id: 'wait', tool: 'wait',
        agentsStates: { child: { status: 'completed', message: null } } },
        { type: 'agentMessage', id: 'final', turnId: 't', text: 'Final reply', phase: 'final_answer' }],
      activeTurnId: null, turnTimings: { t: { id: 't', status: 'completed', startedAt: 1, completedAt: 3, durationMs: 2000 } },
      loading: false, hasMoreHistory: false, loadingHistory: false, onLoadEarlier: async () => {} })));
    expect(html.match(/class="subagent-row"/g)).toHaveLength(1);
    expect(html).toContain('查看子智能体 Atlas');
    expect(html).toContain('已完成');
    expect(html).toContain('Final reply');
    expect(html).not.toContain('class="activity-body"');
  });
  it('does not duplicate an agent whose first activity arrives after the final answer', () => {
    const html = renderToStaticMarkup(createElement(ThreadTimeline, { threadId: 'parent',
      items: [{ type: 'agentMessage', id: 'final', turnId: 't', text: 'Final', phase: 'final_answer' },
        { ...spawn, agentsStates: { child: { status: 'completed', message: null } } }],
      activeTurnId: null, turnTimings: { t: { id: 't', status: 'completed', startedAt: 1, completedAt: 3, durationMs: 2000 } },
      loading: false, hasMoreHistory: false, loadingHistory: false, onLoadEarlier: async () => {} }));
    expect(html.match(/class="subagent-row"/g)).toHaveLength(1);
  });
  it('keeps one visible entrance and continuous native operations across repeated child updates in an active turn', () => {
    const command = (id: string): ThreadItem => ({ type: 'commandExecution', id, turnId: 't',
      command: 'echo synthetic', cwd: '/project', status: 'completed',
      aggregatedOutput: null, exitCode: 0, durationMs: 1 });
    const html = renderToStaticMarkup(createElement(SubagentsContext.Provider, { value: { threads: [child], open: () => {} } },
      createElement(ThreadTimeline, { threadId: 'parent', items: [
        spawn, command('a'), { ...spawn, id: 'wait', tool: 'wait' }, command('b'),
        { type: 'subAgentActivity', id: 'done', turnId: 't', kind: 'completed',
          agentThreadId: 'child', agentPath: '/root/loading', model: null, reasoningEffort: null },
        command('c'),
        { type: 'agentMessage', id: 'commentary', turnId: 't', phase: 'commentary', text: 'VISIBLE_PROGRESS' },
        command('d')
      ], activeTurnId: 't', turnTimings: {}, loading: false, hasMoreHistory: false,
      loadingHistory: false, onLoadEarlier: async () => {} })));
    expect(html.match(/class="subagent-row"/g)).toHaveLength(1);
    expect(html.match(/class="activity-group-toggle"/g)).toHaveLength(2);
    expect(html.indexOf('class="subagent-row"')).toBeLessThan(html.indexOf('class="activity-group"'));
    expect(html).toContain('VISIBLE_PROGRESS');
    expect(html).toContain('已完成');
  });
  it('shows native startup and failure before an agent has a thread ID', () => {
    const render = (status: 'inProgress' | 'failed') => renderToStaticMarkup(createElement(ThreadTimeline, {
      threadId: 'parent', items: [{ ...spawn, status, receiverThreadIds: [], agentsStates: {} }],
      activeTurnId: 't', turnTimings: {}, loading: false, hasMoreHistory: false, loadingHistory: false, onLoadEarlier: async () => {}
    }));
    expect(render('inProgress')).toContain('正在启动子智能体');
    expect(render('failed')).toContain('子智能体启动失败');
    expect(render('failed')).not.toContain('aria-label="查看子智能体');
  });
});
