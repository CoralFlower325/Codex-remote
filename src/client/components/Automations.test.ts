import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Automations } from './Automations';
import type { RemoteState } from '../useRemote';

describe('automations dialog', () => {
  it('renders the native-style list shell with a create entry', () => {
    const remote = { projects: [], models: [] } as unknown as RemoteState;
    const html = renderToStaticMarkup(createElement(Automations, {
      remote, onClose: () => {}, onOpenThread: () => {}
    }));
    expect(html).toContain('自动任务');
    expect(html).toContain('新建自动任务');
    expect(html).toContain('正在加载…');
  });
});
