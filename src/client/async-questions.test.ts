import { describe, expect, it } from 'vitest';
import { pendingQuestionGroups } from './async-questions';
import { asyncQuestions, parseQuestionReplies, questionItemId, serializeQuestionReplies } from '../shared/async-user-input';
import { userMessageText } from '../shared/user-message';
import type { ThreadItem } from './types';

const questions = [{ title: '选择方案？', options: ['方案 A', '方案 B'] }, { title: '补充说明？', options: null }];
const message: ThreadItem = { type: 'agentMessage', id: 'call-1', turnId: 't', text: 'Question fallback',
  delivery: 'async', questions };
const reply = (index: number, answer: string) => ({ questionItemId: questionItemId(message.id, index),
  question: questions[index]!.title, answer });

describe('native asynchronous questions', () => {
  it('retains native indices, options, and free text questions', () => {
    expect(pendingQuestionGroups([message])[0]?.questions).toEqual(questions.map((question, index) => ({
      ...question, id: JSON.stringify(['request_user_input_async', 'call-1', index])
    })));
    expect(pendingQuestionGroups([message])).toHaveLength(1);
  });
  it('keeps unanswered groups across idle, Goal continuation and replies in a later turn', () => {
    const continuation: ThreadItem = { type: 'agentMessage', id: 'next', turnId: 'next-turn', text: 'Continuing' };
    expect(pendingQuestionGroups([message, continuation])).toHaveLength(1);
    const answer: ThreadItem = { type: 'userMessage', id: 'reply-later', turnId: 'reply-turn', content: [{ type: 'text',
      text: serializeQuestionReplies([reply(0, 'A'), reply(1, 'Details')]) }] };
    expect(pendingQuestionGroups([message, continuation, answer])).toEqual([]);
  });
  it('round trips multiple selected or multiline custom answers with native Desktop envelopes', () => {
    const replies = [reply(0, '方案 B'), reply(1, 'Line 1\nLine 2 <>&"')];
    const text = serializeQuestionReplies(replies);
    expect(text).toBe(`<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`);
    expect(parseQuestionReplies(text)).toEqual(replies);
    expect(userMessageText(text)).toBe('选择方案？\n方案 B\n\n补充说明？\nLine 1\nLine 2 <>&"');
  });
  it('recognizes replies from another client, including partial groups, without renumbering', () => {
    const answer: ThreadItem = { type: 'userMessage', id: 'reply', turnId: 't', content: [{ type: 'text',
      text: serializeQuestionReplies([reply(0, '方案 A')]) }] };
    expect(pendingQuestionGroups([message, answer])[0]?.questions).toEqual([
      { ...questions[1], id: questionItemId(message.id, 1) }
    ]);
    answer.content[0]!.text = serializeQuestionReplies([reply(0, '方案 A'), reply(1, 'Details')]);
    expect(pendingQuestionGroups([message, answer])).toEqual([]);
  });
  it('does not treat fallback prose, invalid JSON or unrelated envelopes as submitted answers', () => {
    for (const text of ['方案 A', '<send_user_message_question_reply>broken</send_user_message_question_reply>',
      '<send_user_message_question_reply>{}</send_user_message_question_reply>',
      '<send_user_message_question_reply>[{"questionItemId":3}]</send_user_message_question_reply>']) {
      expect(parseQuestionReplies(text)).toEqual([]);
      expect(userMessageText(text)).toBe(text);
    }
    expect(() => serializeQuestionReplies([])).toThrow();
    expect(() => serializeQuestionReplies([reply(0, '  ')])).toThrow();
  });
  it('rejects malformed question groups instead of shifting native indices', () => {
    for (const value of [null, {}, [], [{ title: '' }], [{ title: 'Valid' }, { title: 42 }],
      [{ title: 'Question', options: [42] }], [{ title: 'Question', options: [''] }]]) {
      expect(asyncQuestions(value)).toEqual([]);
    }
    expect(asyncQuestions([{ title: 'Question' }])).toEqual([{ title: 'Question', options: null }]);
    expect(asyncQuestions([{ title: 'Question', options: [] }])).toEqual([{ title: 'Question', options: [] }]);
  });
});
