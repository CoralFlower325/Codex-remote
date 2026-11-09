import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sidebar } from './Sidebar';
import type { SidebarView } from './Sidebar';
import type { Thread } from '../types';

const noop = () => {};
const archive = async () => {};
const remote: SidebarView = {
  status: 'ready',
  connected: true,
  chatTransport: {
    rpc: async <T>() => undefined as T,
    subscribe: () => () => {},
    watch: () => {}
  },
  threads: [],
  threadsLoading: false,
  models: [],
  projects: [],
  showArchived: false,
  questionCounts: {},
  serverRequests: [],
  refreshThreads: async () => [],
  refreshProjects: async () => {},
  toggleArchived: async () => {},
  setLastError: () => {}
};

const thread = (id: string, type: Thread['status']['type']): Thread => ({
  id,
  name: id,
  preview: '',
  cwd: '/project',
  projectId: null,
  model: null,
  modelProvider: 'openai',
  reasoningEffort: null,
  createdAt: 1,
  updatedAt: 1,
  status: { type }
});

describe('conversation sidebar navigation', () => {
  it.each(['desktop', 'mobile'] as const)('keeps useful navigation with a plain title on %s', layout => {
    const html = renderToStaticMarkup(createElement(Sidebar, {
      remote, layout, activeThreadId: null, open: true, collapsed: false, search: '',
      onSearchChange: noop, onClose: noop, onToggleCollapse: noop,
      onNewTask: noop, onSelectThread: noop, onArchiveThread: archive, onLogout: noop
    }));
    expect(html).toContain('<div class="sidebar-product"><strong>Codex</strong></div>');
    expect(html).not.toContain('Codex 菜单');
    expect(html).not.toContain('aria-label="帮助"');
    expect(html).not.toContain('developers.openai.com');
    expect(html).toContain('aria-label="设置" aria-haspopup="menu"');
    expect(html).toContain('aria-label="搜索任务"');
    expect(html).toContain('新聊天');
    expect(html).toContain('aria-label="添加工作区"');
  });
});


describe('running conversation indicator', () => {
  it.each(['desktop', 'mobile'] as const)('keeps running, idle and approval states distinct on %s', layout => {
    const task = thread('synthetic', 'active');
    const render = (status: string, attention = false) => renderToStaticMarkup(createElement(Sidebar, {
      remote: { ...remote, threads: [{ ...task, status: { type: status as Thread['status']['type'] } }],
        serverRequests: attention ? [{ requestId: 'request', method: '', params: { threadId: task.id } }] : [] },
      layout, activeThreadId: null, open: true, collapsed: false, search: '',
      onSearchChange: noop, onClose: noop, onToggleCollapse: noop,
      onNewTask: noop, onSelectThread: noop, onArchiveThread: archive, onLogout: noop
    }));
    const running = render('active');
    expect(running).toContain('class="thread-running-spinner"');
    expect(running).toContain('aria-hidden="true"');
    expect(render('idle')).not.toContain('thread-running-spinner');
    const attention = render('active', true);
    expect(attention).not.toContain('thread-running-spinner');
    expect(attention).toContain('等待审批：');
  });
});


describe('pending question indicators', () => {
  it.each(['desktop', 'mobile'] as const)('marks an unselected question chat and clears the badge after native answers on %s', layout => {
    const task = thread('question-chat', 'active');
    const render = (counts: Record<string, number>, blocking = false) => renderToStaticMarkup(createElement(Sidebar, {
      remote: { ...remote, threads: [task], questionCounts: counts,
        serverRequests: blocking ? [{ requestId: 'request', params: { threadId: task.id }, method: 'item/tool/requestUserInput' }] : [] },
      layout, activeThreadId: null, open: true, collapsed: false, search: '',
      onSearchChange: noop, onClose: noop, onToggleCollapse: noop,
      onNewTask: noop, onSelectThread: noop, onArchiveThread: archive, onLogout: noop
    }));
    const pending = render({ [task.id]: 2 });
    expect(pending).toContain('aria-label="等待回答 2 个问题"');
    expect(pending).toContain('>待回答</span>');
    expect(pending).not.toContain('class="thread-running-spinner"');
    expect(render({})).not.toContain('thread-question-badge');
    expect(render({})).toContain('thread-running-spinner');
    expect(render({}, true)).toContain('aria-label="等待回答 1 个问题"');
  });
  it('keeps the approval icon visible alongside an asynchronous question badge', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      remote: { ...remote,
        threads: [thread('thread-running', 'active')],
        questionCounts: { 'thread-running': 1 },
        serverRequests: [{ requestId: 'request', params: { threadId: 'thread-running' },
          method: 'item/commandExecution/requestApproval' }]
      },
      layout: 'desktop', activeThreadId: null, open: true, collapsed: false, search: '',
      onSearchChange: noop, onClose: noop, onToggleCollapse: noop,
      onNewTask: noop, onSelectThread: noop, onArchiveThread: archive, onLogout: noop
    }));
    expect(markup).toContain('lucide-circle-alert');
    expect(markup).toContain('thread-question-badge');
  });
});
