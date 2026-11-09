import { describe, expect, expectTypeOf, it } from 'vitest';

import { projectRemoteViews, type ConnectionView, type ConversationActions, type RemoteViewSource } from './remote-contracts';

const source: RemoteViewSource = {
  authenticated: true,
  connected: true,
  connectionError: false,
  chatTransport: {
    rpc: async <T>() => undefined as T,
    subscribe: () => () => {},
    watch: () => {}
  },
  status: 'ready',
  bridgeStatus: { status: 'ready' },
  threads: [],
  threadsLoading: false,
  models: [],
  permissionProfiles: [],
  defaultPermissionProfile: null,
  projects: [],
  showArchived: false,
  activeThreadId: null,
  activeTurnId: null,
  activeThread: null,
  activeGoal: null,
  items: [],
  turnTimings: {},
  contextUsage: undefined,
  hasMoreHistory: false,
  loadingHistory: false,
  hasNewerHistory: false,
  newerHistoryCursor: null,
  viewingHistory: false,
  loadingLaterHistory: false,
  revealingHistory: false,
  outlineTurns: [],
  outlineError: null,
  loadingThread: false,
  historySnapshot: null,
  threadReady: false,
  threadResumeError: null,
  isNewThread: false,
  serverRequests: [],
  questionCounts: {},
  errors: [],
  lastError: null,
  messageEditPending: false
};

describe('remote view contracts', () => {
  it('projects connection state without exposing directory or conversation state', () => {
    const views = projectRemoteViews(source);
    expectTypeOf(views.connection).toEqualTypeOf<ConnectionView>();
    expect(Object.keys(views.connection).sort()).toEqual([
      'authenticated', 'bridgeStatus', 'chatTransport', 'connected', 'connectionError', 'status'
    ]);
    expect(views.directory.threads).toBe(source.threads);
    expect(views.conversation.items).toBe(source.items);
  });

  it('keeps actions in an explicit capability contract', () => {
    expectTypeOf<ConversationActions>().toHaveProperty('sendTurn');
    expectTypeOf<ConversationActions>().toHaveProperty('openThread');
    expectTypeOf<ConversationActions>().not.toHaveProperty('setLastError');
    expectTypeOf<ConnectionView>().not.toHaveProperty('serverRequests');
  });
});
