import type { Dispatch, SetStateAction } from 'react';

import type { OutlineTurn } from '../shared/thread-outline';
import type { TurnTiming } from '../shared/turn-timing';
import type { ChatTransport } from './chat-transport';
import type { GoalUpdate } from './goal';
import type { BeforeHistoryCommit } from './history-scroll';
import type { UserMessage } from './message-edit';
import type {
  BridgeStatus,
  CollaborationMode,
  ComposerAttachment,
  ContextUsage,
  McpStatus,
  ModelInfo,
  ProjectInfo,
  ReviewTarget,
  ServerRequest,
  SkillInfo,
  SkillsResult,
  Thread,
  ThreadGoal,
  ThreadItem
} from './types';
import type { PermissionProfile } from '../shared/permissions';
import type { QueuedSubmission } from './queued-messages';

export type ConnectionStatus = 'authenticated' | 'disconnected' | BridgeStatus['status'];

export interface ErrorNotice {
  id: string;
  message: string;
}

export interface ConnectionView {
  authenticated: boolean;
  connected: boolean;
  connectionError: boolean;
  chatTransport: ChatTransport;
  status: ConnectionStatus;
  bridgeStatus: BridgeStatus;
}

export interface DirectoryView {
  threads: Thread[];
  threadsLoading: boolean;
  models: ModelInfo[];
  projects: ProjectInfo[];
  showArchived: boolean;
}

export interface PermissionView {
  permissionProfiles: PermissionProfile[];
  defaultPermissionProfile: string | null;
}

export interface ConversationView {
  activeThreadId: string | null;
  activeTurnId: string | null;
  activeThread: Thread | null;
  activeGoal: ThreadGoal | null;
  items: ThreadItem[];
  turnTimings: Record<string, TurnTiming>;
  contextUsage: ContextUsage | undefined;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  hasNewerHistory: boolean;
  newerHistoryCursor: string | null;
  viewingHistory: boolean;
  loadingLaterHistory: boolean;
  revealingHistory: boolean;
  outlineTurns: OutlineTurn[];
  outlineError: string | null;
  loadingThread: boolean;
  historySnapshot: 'loading' | 'failed' | null;
  threadReady: boolean;
  threadResumeError: string | null;
  isNewThread: boolean;
}

export interface AttentionView {
  serverRequests: ServerRequest[];
  questionCounts: Record<string, number>;
  errors: ErrorNotice[];
  lastError: string | null;
  messageEditPending: boolean;
}

export interface ConnectionActions {
  reconnect(): void;
}

export interface DirectoryActions {
  refreshPermissions(cwd?: string): Promise<void>;
  refreshThreads(): Promise<Thread[]>;
  refreshProjects(): Promise<void>;
  toggleArchived(): Promise<void>;
}

export interface ThreadSettingsPatch {
  cwd?: string;
  model?: string;
  effort?: string | null;
  permissions?: string;
  collaborationMode?: CollaborationMode;
}

export interface CreateThreadOptions {
  cwd?: string;
  projectId?: string;
  model?: string;
  effort?: string | null;
  permissions?: string;
  collaborationMode?: CollaborationMode;
}

export interface ThreadOpenOptions {
  silent?: boolean;
  preserveHistory?: boolean;
  force?: boolean;
}

export interface ConversationActions {
  setGoal(threadId: string, update: GoalUpdate): Promise<void>;
  clearGoal(threadId: string): Promise<void>;
  editInterruptedMessage(threadId: string, item: UserMessage, text: string,
    settings?: ThreadSettingsPatch): Promise<void>;
  openThread(threadId: string, options?: ThreadOpenOptions): Promise<void>;
  loadEarlierHistory(beforeCommit?: BeforeHistoryCommit): Promise<void>;
  prefetchEarlierHistory(): Promise<void>;
  loadLaterHistory(beforeCommit?: BeforeHistoryCommit): Promise<void>;
  revealHistory(turnId: string, itemId: string): Promise<boolean>;
  cancelHistoryReveal(): void;
  returnToLatest(): Promise<void>;
  setHistoryReading(threadId: string, reading: boolean): void;
  closeThread(): void;
  createThread(options?: CreateThreadOptions): Promise<Thread>;
  listSkills(cwd?: string): Promise<SkillsResult>;
  listModes(): Promise<{ data: Array<{ mode: string | null }> }>;
  listMcp(threadId?: string): Promise<McpStatus[]>;
  compactThread(threadId: string): Promise<void>;
  reviewThread(threadId: string, target: ReviewTarget): Promise<void>;
  forkThread(threadId: string, lastTurnId?: string): Promise<void>;
  sendTurn(threadId: string, text: string, settings?: ThreadSettingsPatch,
    attachments?: ComposerAttachment[], skills?: SkillInfo[]): Promise<string | undefined>;
  setThreadSettings(threadId: string, settings: ThreadSettingsPatch): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string, archived: boolean): Promise<void>;
  steerTurn(threadId: string, turnId: string, text: string,
    attachments?: ComposerAttachment[], skills?: SkillInfo[]): Promise<void>;
  steerQueued(threadId: string, turnId: string, message: QueuedSubmission): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export interface AttentionActions {
  retryThreadResume(): void;
  dismissError(id: string): void;
  respondToRequest(request: ServerRequest, result: unknown): Promise<void>;
  setLastError: Dispatch<SetStateAction<string | null>>;
}

export interface RemoteViewSource extends ConnectionView, DirectoryView, PermissionView, ConversationView, AttentionView {}

export interface RemoteActionSource extends ConnectionActions, DirectoryActions,
  ConversationActions, AttentionActions {}

export interface RemoteController extends RemoteViewSource, RemoteActionSource {}

export interface RemoteViews {
  connection: ConnectionView;
  directory: DirectoryView;
  permissions: PermissionView;
  conversation: ConversationView;
  attention: AttentionView;
}

export function projectRemoteViews(remote: RemoteViewSource): RemoteViews {
  return {
    connection: {
      authenticated: remote.authenticated,
      connected: remote.connected,
      connectionError: remote.connectionError,
      chatTransport: remote.chatTransport,
      status: remote.status,
      bridgeStatus: remote.bridgeStatus
    },
    directory: {
      threads: remote.threads,
      threadsLoading: remote.threadsLoading,
      models: remote.models,
      projects: remote.projects,
      showArchived: remote.showArchived
    },
    permissions: {
      permissionProfiles: remote.permissionProfiles,
      defaultPermissionProfile: remote.defaultPermissionProfile
    },
    conversation: {
      activeThreadId: remote.activeThreadId,
      activeTurnId: remote.activeTurnId,
      activeThread: remote.activeThread,
      activeGoal: remote.activeGoal,
      items: remote.items,
      turnTimings: remote.turnTimings,
      contextUsage: remote.contextUsage,
      hasMoreHistory: remote.hasMoreHistory,
      loadingHistory: remote.loadingHistory,
      hasNewerHistory: remote.hasNewerHistory,
      newerHistoryCursor: remote.newerHistoryCursor,
      viewingHistory: remote.viewingHistory,
      loadingLaterHistory: remote.loadingLaterHistory,
      revealingHistory: remote.revealingHistory,
      outlineTurns: remote.outlineTurns,
      outlineError: remote.outlineError,
      loadingThread: remote.loadingThread,
      historySnapshot: remote.historySnapshot,
      threadReady: remote.threadReady,
      threadResumeError: remote.threadResumeError,
      isNewThread: remote.isNewThread
    },
    attention: {
      serverRequests: remote.serverRequests,
      questionCounts: remote.questionCounts,
      errors: remote.errors,
      lastError: remote.lastError,
      messageEditPending: remote.messageEditPending
    }
  };
}
