import { useCallback, useEffect, useState } from 'react';
import { v4 as randomUUID } from 'uuid';

import type {
  AttentionActions,
  AttentionView,
  ConnectionView,
  ConversationActions,
  ConversationView,
  DirectoryView,
  PermissionView
} from '../remote-contracts';
import type { ChatInput, QueuedSubmission } from '../queued-messages';
import { editableInterruptedMessage, type UserMessage } from '../message-edit';
import { turnInput } from '../slash-commands';
import type { ComposerAttachment, SkillInfo, Thread } from '../types';
import type { LayoutMode } from '../useResponsiveLayout';
import { ApprovalDock } from './ApprovalDock';
import { Composer, type ComposerCommandProps } from './Composer';
import { EditMessageDialog } from './EditMessageDialog';
import { GoalStatus } from './GoalStatus';
import { QueuedMessages } from './QueuedMessages';
import { QuestionDock } from './QuestionDock';
import { ThreadTimeline } from './ThreadTimeline';

type ThreadScreenActions = Pick<ConversationActions,
  'forkThread' | 'openThread' | 'loadEarlierHistory' | 'prefetchEarlierHistory' | 'loadLaterHistory' |
  'revealHistory' | 'cancelHistoryReveal' | 'returnToLatest' | 'setHistoryReading' |
  'editInterruptedMessage' | 'setGoal' | 'clearGoal' | 'interruptTurn' | 'steerQueued'>;

export interface ThreadScreenProps {
  connection: Pick<ConnectionView, 'authenticated' | 'connected' | 'chatTransport'>;
  directory: Pick<DirectoryView, 'models' | 'showArchived'>;
  permissions: Pick<PermissionView, 'permissionProfiles'>;
  conversation: ConversationView;
  attention: AttentionView;
  actions: ThreadScreenActions & Pick<AttentionActions, 'retryThreadResume' | 'respondToRequest'>;
  thread: Thread;
  layout: LayoutMode;
  model: string;
  effort: string;
  permissionsValue: string;
  cwdChanging: boolean;
  onPermissionsChange: (permissions: string) => Promise<void>;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onSubmit: (text: string, attachments: ComposerAttachment[], skills: SkillInfo[]) => Promise<void>;
  onError: (error: unknown) => void;
  commandProps: ComposerCommandProps;
  onOpenSideChat: (input: ChatInput) => void;
  insertRequest: { id: number; text: string } | null;
}

export function ThreadScreen({
  connection,
  directory,
  permissions,
  conversation,
  attention,
  actions,
  thread,
  layout,
  model,
  effort,
  permissionsValue,
  cwdChanging,
  onPermissionsChange,
  onModelChange,
  onEffortChange,
  onSubmit,
  onError,
  commandProps,
  onOpenSideChat,
  insertRequest
}: ThreadScreenProps) {
  const [queueEnabled, setQueueEnabled] = useState(true);
  const [optimisticQueue, setOptimisticQueue] = useState<QueuedSubmission[]>([]);
  const [queueRefreshToken, setQueueRefreshToken] = useState(0);
  useEffect(() => {
    if (!conversation.activeTurnId) setQueueEnabled(true);
  }, [conversation.activeTurnId]);
  const [editing, setEditing] = useState<UserMessage | null>(null);
  const editDisabled = !connection.connected || !conversation.threadReady || directory.showArchived ||
    Boolean(conversation.activeTurnId) || cwdChanging;
  const editable = !editDisabled && !conversation.viewingHistory
    ? editableInterruptedMessage(conversation.items, conversation.turnTimings, conversation.activeTurnId) : null;
  const forkReply = useCallback((turnId: string) => actions.forkThread(thread.id, turnId), [actions.forkThread, thread.id]);
  return (
    <div className="thread-screen">
      <ThreadTimeline
        key={thread.id}
        threadId={thread.id}
        items={conversation.items}
        loading={conversation.loadingThread}
        snapshotState={conversation.historySnapshot}
        onRetrySnapshot={() => { void actions.openThread(thread.id, { force: true }).catch(onError); }}
        activeTurnId={conversation.activeTurnId}
        threadIdle={thread.status.type === 'idle'}
        turnTimings={conversation.turnTimings}
        hasMoreHistory={conversation.hasMoreHistory}
        loadingHistory={conversation.loadingHistory}
        onLoadEarlier={actions.loadEarlierHistory}
        onPrefetchEarlier={actions.prefetchEarlierHistory}
        outlineTurns={conversation.outlineTurns}
        outlineError={conversation.outlineError}
        viewingHistory={conversation.viewingHistory}
        hasNewerHistory={conversation.hasNewerHistory}
        newerHistoryCursor={conversation.newerHistoryCursor}
        loadingLaterHistory={conversation.loadingLaterHistory}
        revealingHistory={conversation.revealingHistory}
        onLoadLater={actions.loadLaterHistory}
        onRevealHistory={actions.revealHistory}
        onCancelHistoryReveal={actions.cancelHistoryReveal}
        onReturnToLatest={actions.returnToLatest}
        onHistoryReading={actions.setHistoryReading}
        onFork={forkReply}
        onActionError={onError}
        editableMessageId={!attention.messageEditPending ? editable?.id : undefined}
        onEditMessage={setEditing}
      />
      {editing && <EditMessageDialog item={editing} threadId={thread.id} disabled={editDisabled}
        onClose={() => setEditing(null)}
        onSubmit={text => actions.editInterruptedMessage(thread.id, editing, text, {
          model, effort, permissions: permissionsValue
        })} />}

      <div className="thread-bottom">
        {conversation.threadResumeError && <div className="thread-recovery" role="alert">
          <span>{conversation.threadResumeError}</span>
          <button type="button" className="secondary-button" disabled={!connection.connected}
            onClick={actions.retryThreadResume}>重试连接此会话</button>
        </div>}
        <div className="thread-pending">
          <GoalStatus key={thread.id} goal={conversation.activeGoal}
            disabled={!connection.connected || !conversation.threadReady || directory.showArchived ||
              attention.messageEditPending}
            onUpdate={update => actions.setGoal(thread.id, update)}
            onDelete={() => actions.clearGoal(thread.id)} onError={onError} />
          <ApprovalDock
            requests={attention.serverRequests.filter(request => request.params.threadId === thread.id)}
            onRespond={actions.respondToRequest}
            onError={onError}
          />
          {!conversation.viewingHistory && <QuestionDock items={conversation.items}
            disabled={!connection.connected || !conversation.threadReady || directory.showArchived ||
              attention.messageEditPending || cwdChanging}
            onSubmit={text => onSubmit(text, [], [])} onError={onError} />}
          {!conversation.isNewThread && <QueuedMessages transport={connection.chatTransport} threadId={thread.id}
            readable={connection.authenticated && !directory.showArchived}
            activeTurnId={conversation.activeTurnId}
            connected={connection.connected && conversation.threadReady && !attention.messageEditPending}
            onError={onError} onOpenSideChat={onOpenSideChat}
            onSteerQueued={conversation.activeTurnId
              ? message => actions.steerQueued(thread.id, conversation.activeTurnId!, message)
              : undefined}
            forceCollapsed={attention.serverRequests.some(request => request.params.threadId === thread.id)}
            queueEnabled={queueEnabled} onQueueEnabledChange={setQueueEnabled}
            optimisticMessages={optimisticQueue}
            onOptimisticSettled={clientUserMessageIds => setOptimisticQueue(current =>
              current.filter(message => !clientUserMessageIds.includes(message.clientUserMessageId)))}
            refreshToken={queueRefreshToken} />}
        </div>
        <Composer
          {...commandProps}
          variant="thread"
          draftKey={thread.id}
          insertRequest={insertRequest}
          disabled={!connection.connected || !conversation.threadReady || directory.showArchived ||
            attention.messageEditPending || cwdChanging}
          layout={layout}
          model={model}
          effort={effort}
          permissions={permissionsValue}
          permissionProfiles={permissions.permissionProfiles}
          onPermissionsChange={onPermissionsChange}
          models={directory.models}
          activeTurnId={conversation.activeTurnId}
          queueMessages={queueEnabled}
          {...(conversation.contextUsage ? { contextUsage: conversation.contextUsage } : {})}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onSubmit={async (text, attachments, skills) => {
            if (conversation.activeTurnId && queueEnabled) {
              const clientUserMessageId = randomUUID();
              const input = turnInput(text, attachments, skills);
              setOptimisticQueue(current => [...current, {
                id: `pending:${clientUserMessageId}`,
                clientUserMessageId,
                input
              }]);
              try {
                await connection.chatTransport.rpc('thread/queue/add', {
                  threadId: thread.id, clientUserMessageId, input
                });
                setQueueRefreshToken(value => value + 1);
              } catch (error) {
                setOptimisticQueue(current =>
                  current.filter(message => message.clientUserMessageId !== clientUserMessageId));
                throw error;
              }
            } else await onSubmit(text, attachments, skills);
          }}
          {...(conversation.activeTurnId
            ? { onStop: () => actions.interruptTurn(thread.id, conversation.activeTurnId!) }
            : {})}
          onError={onError}
        />
      </div>
    </div>
  );
}
