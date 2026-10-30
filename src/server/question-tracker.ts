import { asyncQuestions, parseQuestionReplies, questionItemId } from '../shared/async-user-input.js';

export const questionTrackerLimits = { threads: 1000, idsPerThread: 1000 } as const;
interface Questions { pending: Set<string>; answered: Set<string> }
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

/** Count-only, bounded memory state. Never scan all task histories or persist question bodies. */
export class QuestionTracker {
  private threads = new Map<string, Questions>();

  constructor(private readonly limits: { threads: number; idsPerThread: number } = questionTrackerLimits) {}

  pendingIds(threadId: string): Set<string> {
    return new Set(this.threads.get(threadId)?.pending ?? []);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.threads].filter(([, state]) => state.pending.size)
      .map(([threadId, state]) => [threadId, state.pending.size]));
  }

  ingest(threadId: string, values: unknown[]): boolean {
    if (!threadId || !Array.isArray(values)) return false;
    const relevant = values.map(record).filter(item => item &&
      (item.type === 'agentMessage' && typeof item.id === 'string' && asyncQuestions(item.questions).length ||
       item.type === 'userMessage' && Array.isArray(item.content) && item.content.some((input: unknown) => {
         const text = record(input);
         return text?.type === 'text' && typeof text.text === 'string' && parseQuestionReplies(text.text).length;
       })));
    if (!relevant.length) return false;
    const before = this.snapshot();
    const state = this.threads.get(threadId) ?? { pending: new Set<string>(), answered: new Set<string>() };
    this.threads.delete(threadId);
    this.threads.set(threadId, state);
    for (const item of relevant) {
      if (item?.type === 'userMessage') {
        for (const input of item.content as unknown[]) {
          const text = record(input);
          if (text?.type !== 'text' || typeof text.text !== 'string') continue;
          for (const reply of parseQuestionReplies(text.text)) {
            state.answered.add(reply.questionItemId);
            state.pending.delete(reply.questionItemId);
          }
        }
      } else if (item?.type === 'agentMessage') {
        for (const [index] of asyncQuestions(item.questions).entries()) {
          const id = questionItemId(item.id as string, index);
          if (!state.answered.has(id)) state.pending.add(id);
        }
      }
    }
    for (const ids of [state.pending, state.answered]) {
      while (ids.size > this.limits.idsPerThread) ids.delete(ids.values().next().value!);
    }
    while (this.threads.size > this.limits.threads) this.threads.delete(this.threads.keys().next().value!);
    const after = this.snapshot();
    const changed = Object.keys(before).length !== Object.keys(after).length ||
      Object.entries(after).some(([id, count]) => before[id] !== count);
    if (changed) console.debug('[async-questions] summary changed', { threads: this.threads.size, pending: state.pending.size });
    return changed;
  }

  event(method: string, params: Record<string, unknown>): boolean {
    if (typeof params.threadId !== 'string' || !params.threadId) return false;
    if (method === 'thread/deleted' || method === 'thread/archived') {
      const hadQuestions = Boolean(this.threads.get(params.threadId)?.pending.size);
      this.threads.delete(params.threadId);
      return hadQuestions;
    }
    if (method === 'item/started' || method === 'item/completed') return this.ingest(params.threadId, [params.item]);
    if (method === 'turn/started' || method === 'turn/completed') {
      const items = record(params.turn)?.items;
      return Array.isArray(items) && this.ingest(params.threadId, items);
    }
    return false;
  }
}
