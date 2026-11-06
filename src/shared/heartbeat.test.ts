import { describe, expect, it } from 'vitest';

import { heartbeatResponseText, parseHeartbeatPrompt, parseHeartbeatResponse } from './heartbeat.js';
import { outlineMessages } from './thread-outline.js';

const promptEnvelope = [
  '<heartbeat>',
  '  <automation_id>v10-20</automation_id>',
  '  <current_time_iso>2026-11-06T16:28:00.807Z</current_time_iso>',
  '  <instructions>',
  '对当前页面做一次严格只读的状态检查，并给出预计完成时间。',
  '',
  '- 只观察页面，不点击、不输入。',
  '- 简要报告运行状态与最近日志时间。',
  '  </instructions>',
  '</heartbeat>'
].join('\n');

const responseEnvelope = '<heartbeat> <automation_id>v10-20</automation_id> <decision>NOTIFY</decision> ' +
  '<message>训练正常推进：已完成第 25 轮，最近日志 00:28:03，无可见 OOM。</message> </heartbeat>';

describe('heartbeat prompt envelopes', () => {
  it('extracts the automation id and only the instructions', () => {
    expect(parseHeartbeatPrompt(promptEnvelope)).toEqual({
      automationId: 'v10-20',
      instructions: '对当前页面做一次严格只读的状态检查，并给出预计完成时间。\n\n- 只观察页面，不点击、不输入。\n- 简要报告运行状态与最近日志时间。'
    });
  });

  it('parses an envelope without the optional metadata elements', () => {
    expect(parseHeartbeatPrompt('<heartbeat><instructions>检查状态</instructions></heartbeat>'))
      .toEqual({ automationId: null, instructions: '检查状态' });
    expect(parseHeartbeatPrompt('<heartbeat>\n<automation_id>a-1</automation_id>\n<instructions>检查状态</instructions>\n</heartbeat>'))
      .toEqual({ automationId: 'a-1', instructions: '检查状态' });
  });

  it('keeps instruction markup and headings verbatim', () => {
    const parsed = parseHeartbeatPrompt('<heartbeat><instructions># 标题\n使用 <b> 标签说明。</instructions></heartbeat>');
    expect(parsed?.instructions).toBe('# 标题\n使用 <b> 标签说明。');
  });

  it('rejects prose, fragments and envelopes embedded in larger text', () => {
    expect(parseHeartbeatPrompt('普通消息')).toBeNull();
    expect(parseHeartbeatPrompt('<heartbeat><instructions>未闭合')).toBeNull();
    expect(parseHeartbeatPrompt(`先说明一下：\n${promptEnvelope}`)).toBeNull();
    expect(parseHeartbeatPrompt(`${promptEnvelope}\n以上是引用`)).toBeNull();
    expect(parseHeartbeatPrompt('<heartbeat><instructions>  </instructions></heartbeat>')).toBeNull();
    expect(parseHeartbeatPrompt(responseEnvelope)).toBeNull();
  });
});

describe('heartbeat response envelopes', () => {
  it('extracts the decision and only the message', () => {
    expect(parseHeartbeatResponse(responseEnvelope)).toEqual({
      automationId: 'v10-20',
      decision: 'NOTIFY',
      message: '训练正常推进：已完成第 25 轮，最近日志 00:28:03，无可见 OOM。'
    });
  });

  it('parses multiline DONT_NOTIFY replies and preserves message markup', () => {
    const text = ['<heartbeat>', '<automation_id>a-1</automation_id>', '<decision>DONT_NOTIFY</decision>',
      '<message>状态未变：<b>第 3 轮</b> 仍在运行。</message>', '</heartbeat>'].join('\n');
    expect(parseHeartbeatResponse(text)).toEqual({
      automationId: 'a-1',
      decision: 'DONT_NOTIFY',
      message: '状态未变：<b>第 3 轮</b> 仍在运行。'
    });
  });

  it('rejects non-envelopes and the prompt envelope', () => {
    expect(parseHeartbeatResponse('普通回复')).toBeNull();
    expect(parseHeartbeatResponse(promptEnvelope)).toBeNull();
    expect(parseHeartbeatResponse('<heartbeat><decision>NOTIFY</decision><message></message></heartbeat>')).toBeNull();
  });

  it('projects reply text for previews and copies', () => {
    expect(heartbeatResponseText(responseEnvelope)).toBe('训练正常推进：已完成第 25 轮，最近日志 00:28:03，无可见 OOM。');
    expect(heartbeatResponseText('普通回复')).toBe('普通回复');
  });
});

describe('outline projection', () => {
  it('shows automation instructions and reply message instead of envelopes', () => {
    const messages = outlineMessages([
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: promptEnvelope }] },
      { type: 'agentMessage', id: 'a1', text: responseEnvelope, phase: 'final_answer' }
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.prompt).toContain('对当前页面做一次严格只读的状态检查');
    expect(messages[0]!.prompt).not.toContain('heartbeat');
    expect(messages[0]!.reply).toContain('训练正常推进');
    expect(messages[0]!.reply).not.toContain('decision');
  });
});
