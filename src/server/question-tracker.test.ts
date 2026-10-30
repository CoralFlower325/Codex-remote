import { describe, expect, it } from 'vitest';
import { QuestionTracker } from './question-tracker.js';
import { questionItemId, serializeQuestionReplies } from '../shared/async-user-input.js';
import { EventJournal } from './event-journal.js';

const question = (id = 'synthetic-question') => ({ type: 'agentMessage', id, text: '', delivery: 'async',
  questions: [{ title: 'Choose?', options: ['A', 'B'] }, { title: 'Details?', options: null }] });
const reply = (indices = [0, 1]) => ({ type: 'userMessage', id: 'answer', content: [{ type: 'text',
  text: serializeQuestionReplies(indices.map(index => ({ questionItemId: questionItemId('synthetic-question', index),
    question: 'Synthetic question', answer: 'Synthetic answer' }))) }] });

describe('count-only native question summaries', () => {
  it('tracks unseen chat questions, whole-turn arrivals, repeated events and partial replies', () => {
    const tracker = new QuestionTracker();
    expect(tracker.event('turn/started', { threadId: 'unwatched', turn: { id: 'first', items: [question()] } })).toBe(true);
    expect(tracker.snapshot()).toEqual({ unwatched: 2 });
    expect(tracker.event('item/completed', { threadId: 'unwatched', item: question() })).toBe(false);
    expect(tracker.event('turn/started', { threadId: 'unwatched', turn: { id: 'goal-next', items: [] } })).toBe(false);
    expect(tracker.event('item/started', { threadId: 'unwatched', item: reply([0]) })).toBe(true);
    expect(tracker.snapshot()).toEqual({ unwatched: 1 });
    tracker.event('turn/completed', { threadId: 'unwatched', turn: { items: [reply()] } });
    expect(tracker.snapshot()).toEqual({});
    // An old history response completing after a native reply cannot resurrect it.
    expect(tracker.ingest('unwatched', [question()])).toBe(false);
    expect(tracker.snapshot()).toEqual({});
  });
  it('hydrates existing bounded history without depending on reply ordering', () => {
    const tracker = new QuestionTracker();
    tracker.ingest('history', [reply([0]), question()]);
    expect(tracker.snapshot()).toEqual({ history: 1 });
    expect(tracker.event('thread/archived', { threadId: 'history' })).toBe(true);
    expect(tracker.snapshot()).toEqual({});
  });
  it('does not infer answers from prose or malformed external data', () => {
    const tracker = new QuestionTracker();
    for (const params of [{}, { threadId: 42 }, { threadId: 'chat', turn: null }, { threadId: 'chat', turn: { items: {} } }]) {
      expect(tracker.event('turn/completed', params)).toBe(false);
    }
    tracker.ingest('chat', [null, {}, { type: 'agentMessage', id: 42, questions: question().questions },
      { ...question(), questions: [{ title: 42 }] }, { type: 'userMessage', content: [null, { type: 'text', text: 'A' }] }]);
    expect(tracker.snapshot()).toEqual({});
    tracker.ingest('chat', [question(), { type: 'userMessage', content: [{ type: 'text', text: 'A' }] }]);
    expect(tracker.snapshot()).toEqual({ chat: 2 });
  });
  it('bounds memory and publishes no private bodies through the global replay path', () => {
    const tracker = new QuestionTracker({ threads: 2, idsPerThread: 2 });
    for (const threadId of ['first', 'second', 'third']) tracker.ingest(threadId, [question(), question('next')]);
    expect(tracker.snapshot()).toEqual({ second: 2, third: 2 });
    const journal = new EventJournal();
    journal.append({ type: 'questions.snapshot', counts: tracker.snapshot() });
    const entries = journal.resume(journal.epoch, 0, new Set(['unrelated'])).entries;
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.payload).counts).toEqual(tracker.snapshot());
    expect(entries[0]!.payload).not.toContain('Choose?');
    expect(entries[0]!.payload).not.toContain('Synthetic answer');
  });
});
