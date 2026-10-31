import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NativeTurnError } from './NativeTurnError';
import type { TurnTiming } from '../../shared/turn-timing';
import { ThreadTimeline } from './ThreadTimeline';

describe('native turn error display', () => {
  it('keeps a user-only failure visible and outside a collapsed process fold', () => {
    const turn: TurnTiming = { id: 't', status: 'failed', startedAt: 1, completedAt: 2, durationMs: 1000,
      error: { message: 'Native failure', codexErrorInfo: 'rateLimitExceeded' } };
    const props = { threadId: 'chat', items: [{ id: 'u', turnId: 't', type: 'userMessage' as const,
      content: [{ type: 'text', text: 'Synthetic question' }] }], loading: false, activeTurnId: null,
      turnTimings: { t: turn }, hasMoreHistory: false, loadingHistory: false, onLoadEarlier: async () => {} };
    const html = renderToStaticMarkup(createElement(ThreadTimeline, props));
    expect(html).toContain('Native failure');
    expect(html.match(/data-native-error=/g)).toHaveLength(1);
    const folded = renderToStaticMarkup(createElement(ThreadTimeline, { ...props, items: [...props.items,
      { type: 'commandExecution', id: 'r', turnId: 't', command: 'synthetic', cwd: '/',
        status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 10 }] }));
    expect(folded).toContain('Native failure');
    expect(folded.match(/data-native-error=/g)).toHaveLength(1);
  });
  it('shows escaped native text and retry state without invented headings or status codes', () => {
    const turn: TurnTiming = { id: 't', status: 'inProgress', startedAt: null, completedAt: null, durationMs: null,
      errorWillRetry: true, error: { message: '<script>example</script>', additionalDetails: 'Synthetic details',
        codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } } };
    const html = renderToStaticMarkup(createElement(NativeTurnError, { turn }));
    expect(html).toContain('&lt;script&gt;example&lt;/script&gt;');
    expect(html).toContain('Synthetic details');
    expect(html).not.toContain('HTTP 429');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<script>');
    const failed = renderToStaticMarkup(createElement(NativeTurnError, { turn: { ...turn, status: 'failed' } }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Synthetic details');
  });
  it('keeps an actual HTTP error intact without duplicating its code', () => {
    const turn: TurnTiming = { id: 't', status: 'failed', startedAt: null, completedAt: null, durationMs: null,
      error: { message: 'Unexpected status 429 Too Many Requests',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } };
    const html = renderToStaticMarkup(createElement(NativeTurnError, { turn }));
    expect(html.match(/429/g)).toHaveLength(1);
    expect(html).toContain('Unexpected status 429 Too Many Requests');
  });
});
