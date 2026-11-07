import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MessageItem } from './TurnResponse';
import type { ThreadItem } from '../types';

const promptEnvelope = [
  '<heartbeat>',
  '  <automation_id>v10-20</automation_id>',
  '  <current_time_iso>2026-11-06T16:28:00.807Z</current_time_iso>',
  '  <instructions>',
  '对当前页面做一次严格只读的状态检查。',
  '  </instructions>',
  '</heartbeat>'
].join('\n');

const render = (item: ThreadItem) => renderToStaticMarkup(createElement(MessageItem, { item }));

describe('automation heartbeat rendering', () => {
  it('renders only the instructions with an automation label for a trigger message', () => {
    const html = render({ type: 'userMessage', id: 'u1', turnId: 'turn', content: [{ type: 'text', text: promptEnvelope }] } as ThreadItem);
    expect(html).toContain('由自动任务发送');
    expect(html).toContain('对当前页面做一次严格只读的状态检查。');
    expect(html).not.toContain('heartbeat');
    expect(html).not.toContain('automation_id');
    expect(html).not.toContain('current_time_iso');
  });

  it('renders an ordinary user message unchanged', () => {
    const html = render({ type: 'userMessage', id: 'u2', turnId: 'turn', content: [{ type: 'text', text: '普通消息' }] } as ThreadItem);
    expect(html).toContain('普通消息');
    expect(html).not.toContain('由自动任务发送');
  });

  it('renders only the message for a NOTIFY heartbeat reply', () => {
    const text = '<heartbeat> <automation_id>v10-20</automation_id> <decision>NOTIFY</decision> ' +
      '<message>训练正常推进：已完成第 25 轮。</message> </heartbeat>';
    const html = render({ type: 'agentMessage', id: 'a1', turnId: 'turn', phase: 'final_answer', text, startedAtMs: null, completedAtMs: null } as ThreadItem);
    expect(html).toContain('训练正常推进：已完成第 25 轮。');
    expect(html).not.toContain('heartbeat');
    expect(html).not.toContain('decision');
    expect(html).not.toContain('无需通知');
  });

  it('renders a DONT_NOTIFY heartbeat reply quietly with its label', () => {
    const text = '<heartbeat><automation_id>v10-20</automation_id><decision>DONT_NOTIFY</decision>' +
      '<message>状态未变，仍在运行。</message></heartbeat>';
    const html = render({ type: 'agentMessage', id: 'a2', turnId: 'turn', phase: 'final_answer', text, startedAtMs: null, completedAtMs: null } as ThreadItem);
    expect(html).toContain('自动任务 · 无需通知');
    expect(html).toContain('message--automation-quiet');
    expect(html).toContain('状态未变，仍在运行。');
    expect(html).not.toContain('heartbeat');
  });

  it('renders an ordinary agent message unchanged', () => {
    const html = render({ type: 'agentMessage', id: 'a3', turnId: 'turn', phase: 'final_answer', text: '普通回复', startedAtMs: null, completedAtMs: null } as ThreadItem);
    expect(html).toContain('普通回复');
    expect(html).not.toContain('无需通知');
  });

  it('preserves visible reply prose around a fenced envelope without repeating its notification message', () => {
    const text = 'Visible **update**.\n\n```xml\n<heartbeat><decision>NOTIFY</decision>' +
      '<message>Notification preview only.</message></heartbeat>\n```';
    const html = render({ type: 'agentMessage', id: 'a4', turnId: 'turn', phase: 'final_answer', text } as ThreadItem);
    expect(html).toContain('Visible <strong>update</strong>.');
    expect(html).not.toContain('Notification preview only.');
    expect(html).not.toContain('heartbeat');
  });

  it('does not flash an incomplete envelope in a streaming heartbeat turn', () => {
    const item = { type: 'agentMessage', id: 'a5', turnId: 'turn', phase: 'final_answer',
      text: '<heartbeat><decision>NOT' } as ThreadItem;
    expect(renderToStaticMarkup(createElement(MessageItem, { item, streamingHeartbeat: true }))).toBe('');
    expect(render(item)).toContain('&lt;heartbeat&gt;');
  });
});
