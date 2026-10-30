import { asyncQuestions, parseQuestionReplies, questionItemId, type AsyncQuestion } from '../shared/async-user-input';
import type { ThreadItem } from './types';

export interface PendingQuestion extends AsyncQuestion { id: string }
export interface QuestionGroup { id: string; questions: PendingQuestion[] }

/** Match native persisted replies; never infer an answer from unrelated prose. */
export function pendingQuestionGroups(items: ThreadItem[]): QuestionGroup[] {
  const answered = new Set(items.flatMap(item => item.type === 'userMessage'
    ? item.content.flatMap(input => input.type === 'text' && typeof input.text === 'string'
      ? parseQuestionReplies(input.text).map(reply => reply.questionItemId) : []) : []));
  return items.flatMap(item => {
    if (item.type !== 'agentMessage') return [];
    const questions = asyncQuestions(item.questions).map((question, index) => ({
      ...question, id: questionItemId(item.id, index)
    })).filter(question => !answered.has(question.id));
    return questions.length ? [{ id: questionItemId(item.id, -1), questions }] : [];
  });
}
