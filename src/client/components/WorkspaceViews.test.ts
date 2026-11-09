import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HomeView } from './HomeView';
import { ThreadScreen } from './ThreadScreen';
import type { ComposerCommandProps } from './Composer';
import type { AttentionView, ConnectionView, ConversationView } from '../remote-contracts';
import type { ChatTransport } from '../chat-transport';
import type { Thread } from '../types';

const noop = () => {};
const asyncNoop = async () => {};
const transport: ChatTransport = {
  rpc: async <T>() => undefined as T,
  subscribe: () => () => {},
  watch: () => {}
};
const connection: Pick<ConnectionView, 'authenticated' | 'connected' | 'chatTransport'> = {
  authenticated: true,
  connected: true,
  chatTransport: transport
};
const commandProps: ComposerCommandProps = {
  onCommand: asyncNoop,
  loadSkills: async () => ({ skills: [], errors: [] }),
  skillScope: '/workspace',
  hasSavedThread: false,
  mode: 'default'
};
const thread: Thread = {
  id: 'thread',
  name: 'Thread',
  preview: '',
  cwd: '/workspace',
  projectId: null,
  model: null,
  modelProvider: 'openai',
  reasoningEffort: null,
  createdAt: 1,
  updatedAt: 1,
  status: { type: 'idle' }
};
const conversation: ConversationView = {
  activeThreadId: thread.id,
  activeTurnId: null,
  activeThread: thread,
  activeGoal: null,
  items: [],
  turnTimings: {},
  contextUsage: undefined,
  hasMoreHistory: false,
  loadingHistory: false,
  hasNewerHistory: false,
  newerHistoryCursor: null,
  viewingHistory: true,
  loadingLaterHistory: false,
  revealingHistory: false,
  outlineTurns: [],
  outlineError: null,
  loadingThread: false,
  historySnapshot: null,
  threadReady: true,
  threadResumeError: null,
  isNewThread: true
};
const attention: AttentionView = {
  serverRequests: [],
  questionCounts: {},
  errors: [],
  lastError: null,
  messageEditPending: false
};

describe('extracted workspace views', () => {
  it('keeps the home project title and responsive composer container', () => {
    const html = renderToStaticMarkup(createElement(HomeView, {
      layout: 'mobile',
      connection,
      directory: {
        models: [],
        projects: [{ id: 'project', name: 'Project', roots: [{ path: '/workspace' }] }]
      },
      permissions: { permissionProfiles: [] },
      selectedProjectId: 'project',
      model: '',
      effort: '',
      permissionsValue: '',
      cwdChanging: false,
      onPermissionsChange: asyncNoop,
      focusRequest: 0,
      onProjectChange: noop,
      onModelChange: noop,
      onEffortChange: noop,
      onSubmit: asyncNoop,
      onError: noop,
      commandProps
    }));
    expect(html).toContain('home-view--mobile');
    expect(html).toContain('在 Project 中需要什么帮助？');
  });

  it('keeps the thread composer and accessibility shell after extraction', () => {
    const html = renderToStaticMarkup(createElement(ThreadScreen, {
      connection,
      directory: { models: [], showArchived: false },
      permissions: { permissionProfiles: [] },
      conversation,
      attention,
      actions: {
        forkThread: asyncNoop,
        openThread: asyncNoop,
        loadEarlierHistory: asyncNoop,
        prefetchEarlierHistory: asyncNoop,
        loadLaterHistory: asyncNoop,
        revealHistory: async () => false,
        cancelHistoryReveal: noop,
        returnToLatest: asyncNoop,
        setHistoryReading: noop,
        editInterruptedMessage: asyncNoop,
        setGoal: asyncNoop,
        clearGoal: asyncNoop,
        interruptTurn: asyncNoop,
        retryThreadResume: noop,
        respondToRequest: asyncNoop
      },
      thread,
      layout: 'desktop',
      model: '',
      effort: '',
      permissionsValue: '',
      cwdChanging: false,
      onPermissionsChange: asyncNoop,
      onModelChange: noop,
      onEffortChange: noop,
      onSubmit: asyncNoop,
      onError: noop,
      commandProps: { ...commandProps, hasSavedThread: true },
      onOpenSideChat: noop,
      insertRequest: null
    }));
    expect(html).toContain('class="thread-screen"');
    expect(html).toContain('继续当前任务');
    expect(html).toContain('placeholder="继续向 Codex 提问"');
    expect(html).toContain('aria-label="发送任务"');
  });
});
