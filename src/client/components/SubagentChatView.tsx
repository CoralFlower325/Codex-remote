import { Bot, RotateCw } from 'lucide-react';
import { subagentChatStatus, subagentStatusLabel } from '../subagents';
import type { SubagentChat } from '../useSubagentChats';
import { PreviewLinks } from './PreviewLinks';
import { SubagentStatusIcon } from './Subagents';
import { ThreadTimeline } from './ThreadTimeline';
import type { BeforeHistoryCommit } from '../history-scroll';

export function SubagentChatView({ chat, onLoadEarlier, onPrefetchEarlier, onRetry }: {
  chat: SubagentChat; onLoadEarlier: (beforeCommit?: BeforeHistoryCommit) => Promise<void>; onRetry: () => Promise<void>;
  onPrefetchEarlier: () => Promise<void>;
}) {
  const name = chat.thread?.agentNickname || chat.agent.name;
  const status = subagentChatStatus(chat);
  return <PreviewLinks cwd={chat.cwd ?? ''}><div className="side-chat-view subagent-chat-view">
    <header className="subagent-chat-heading">
      <Bot size={17} aria-hidden="true" /><strong>{name}</strong>
      {(chat.thread?.agentRole || chat.agent.role) && <span className="subagent-role">{chat.thread?.agentRole || chat.agent.role}</span>}
      <span className={`subagent-status subagent-status--${status ?? 'unknown'}`}>
        <SubagentStatusIcon status={status} />{subagentStatusLabel(status)}
      </span>
      <button type="button" className="icon-button" title="刷新子智能体会话" aria-label="刷新子智能体会话"
        disabled={chat.loading} onClick={() => { void onRetry(); }}><RotateCw size={14} /></button>
    </header>
    {chat.error && <div className="error-banner" role="alert"><span>{chat.error}</span>
      <button type="button" className="icon-button" title="重试" aria-label="重试" onClick={() => { void onRetry(); }}><RotateCw size={14} /></button>
    </div>}
    <ThreadTimeline threadId={chat.id} items={chat.items} turnTimings={chat.timings}
      activeTurnId={chat.activeTurnId} loading={chat.loading} hasMoreHistory={Boolean(chat.cursor)}
      loadingHistory={chat.loadingHistory} onLoadEarlier={onLoadEarlier} onPrefetchEarlier={onPrefetchEarlier} />
    {!chat.loading && !chat.error && !chat.items.length && !Object.values(chat.timings).some(turn => turn.error) &&
      <div className="subagent-empty" role="status">暂无消息</div>}
  </div></PreviewLinks>;
}
