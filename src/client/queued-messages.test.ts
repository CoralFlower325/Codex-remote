import { describe, expect, it } from 'vitest';

import { mergeQueuedMessages, type ChatInput, type QueuedSubmission } from './queued-messages';

const input = (text: string): ChatInput => [{ type: 'text', text, text_elements: [] }];
const queued = (id: string, text: string): QueuedSubmission => ({
  id,
  clientUserMessageId: `client-${id}`,
  input: input(text)
});

describe('queued message reconciliation', () => {
  it('keeps optimistic rows visible until the native queue returns the same client id', () => {
    const native = queued('native', 'Already accepted');
    const optimisticAccepted = queued('optimistic-accepted', 'Accepted by native');
    const optimisticPending = queued('optimistic-pending', 'Still waiting');

    expect(mergeQueuedMessages([native], [optimisticAccepted, optimisticPending])).toEqual({
      messages: [native, optimisticAccepted, optimisticPending],
      settledClientUserMessageIds: []
    });

    expect(mergeQueuedMessages([native, optimisticAccepted], [optimisticAccepted, optimisticPending])).toEqual({
      messages: [native, optimisticAccepted, optimisticPending],
      settledClientUserMessageIds: [optimisticAccepted.clientUserMessageId]
    });
  });

  it('does not duplicate a native queued row after reconciliation', () => {
    const native = queued('same', 'One native row');

    expect(mergeQueuedMessages([native], [native])).toEqual({
      messages: [native],
      settledClientUserMessageIds: [native.clientUserMessageId]
    });
  });
});
