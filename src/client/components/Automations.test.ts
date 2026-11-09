import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Automations } from './Automations';

describe('automations dialog', () => {
  it('renders the native-style list shell with a create entry', () => {
    const html = renderToStaticMarkup(createElement(Automations, {
      models: [], projects: [], onClose: () => {}, onOpenThread: () => {}
    }));
    expect(html).toContain('自动任务');
    expect(html).toContain('新建自动任务');
    expect(html).toContain('正在加载…');
  });
});
