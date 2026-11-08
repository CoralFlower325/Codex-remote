import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalDock } from './ApprovalDock';
import { QuestionCard } from './QuestionDock';

describe('approval rendering with real React', () => {
  it('keeps unknown request diagnostics visible in a collapsed disclosure without inventing approval actions', () => {
    const html = renderToStaticMarkup(createElement(ApprovalDock, {
      requests: [{ requestId: 'unknown', method: 'future/native/requestApproval', params: { reason: '<unsafe>', value: 'x'.repeat(25_000) } }],
      onRespond: vi.fn(), onError: vi.fn()
    }));
    expect(html).toContain('需要在 Desktop 处理');
    expect(html).toContain('复制请求');
    expect(html).toContain('<details class="approval-details">');
    expect(html).toContain('future/native/requestApproval');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('x'.repeat(20_000));
    expect(html).not.toContain('允许一次');
    expect(html).not.toContain('<details class="approval-details" open');
  });

  it('starts real native question choices unselected with submission disabled', () => {
    const html = renderToStaticMarkup(createElement(QuestionCard, {
      group: { id: 'question', questions: [{ id: 'choice', title: 'Choose?', options: ['A', 'B'] }] },
      disabled: false, onSubmit: vi.fn(), onError: vi.fn()
    }));
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('class="primary-button" disabled=""');
  });
});
