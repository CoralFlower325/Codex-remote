import { CircleAlert, MessageCirclePlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { queuedDraft, type ChatInput } from '../queued-messages';
import { turnInput } from '../slash-commands';
import type { RemoteState } from '../useRemote';
import type { SideChat } from '../useSideChats';
import { resolveReasoningEffort } from '../workspace-model';
import { permissionLabel, type PermissionProfile } from '../../shared/permissions';
import { QuestionDock } from './QuestionDock';
import { ApprovalDock } from './ApprovalDock';
import { CommandDialog, type CommandDialogState } from './CommandDialog';
import { Composer } from './Composer';
import { ThreadTimeline } from './ThreadTimeline';
import { PreviewLinks } from './PreviewLinks';

export function SideChatView({ chat, remote, layout, onPatch, onSend, onNew }: {
  chat: SideChat;
  remote: RemoteState;
  layout: 'desktop' | 'mobile';
  onPatch: (changes: Partial<SideChat>) => void;
  onSend: (input: ChatInput) => Promise<void>;
  onNew: () => void;
}) {
  const [profiles, setProfiles] = useState<PermissionProfile[]>([]);
  const [dialog, setDialog] = useState<CommandDialogState | null>(null);
  const onError = (error: unknown) => onPatch({ error: error instanceof Error ? error.message : String(error) });
  useEffect(() => {
    let disposed = false;
    const query = new URLSearchParams(chat.cwd ? { cwd: chat.cwd } : {});
    void api<{ data: PermissionProfile[]; defaultProfile: string | null }>(`/api/permissions?${query}`, { cache: 'no-store' })
      .then(result => {
        if (disposed) return;
        setProfiles(result.data);
        if (!chat.permissions && result.defaultProfile) onPatch({ permissions: result.defaultProfile });
      }).catch(error => { if (!disposed) onError(error); });
    return () => { disposed = true; };
  }, [chat.cwd, remote.connected]);
  const modelInfo = remote.models.find(model => model.model === chat.model);
  const effort = resolveReasoningEffort(modelInfo, chat.effort);

  return <PreviewLinks cwd={chat.cwd ?? ''}><div className="side-chat-view">
    {chat.error && <div className="error-banner" role="alert"><CircleAlert size={15} /><span>{chat.error}</span>
      <button type="button" aria-label="关闭侧聊错误" onClick={() => onPatch({ error: null })}><X size={14} /></button></div>}
    {chat.items.length ? <ThreadTimeline threadId={chat.threadId ?? chat.id}
      items={chat.items} turnTimings={chat.timings} activeTurnId={chat.activeTurnId}
      loading={false} hasMoreHistory={false} loadingHistory={false} onLoadEarlier={async () => {}} onActionError={onError} />
      : <div className="side-chat-empty"><MessageCirclePlus size={28} strokeWidth={1.5} /><h2>侧边聊天</h2>
        <p>临时聊天，关闭标签页后消失。</p></div>}
    <div className="thread-bottom">
      <QuestionDock items={chat.items} disabled={!remote.connected || Boolean(chat.closing || chat.unavailable)}
        onSubmit={text => onSend(turnInput(text, [], []))} onError={onError} />
      <ApprovalDock requests={remote.serverRequests.filter(request => request.params.threadId === chat.threadId)}
        onRespond={remote.respondToRequest} onError={onError} />
      <Composer temporary {...(chat.initialInput ? { initialInput: queuedDraft(chat.initialInput) } : {})}
        variant="thread" draftKey={chat.id} layout={layout} model={chat.model} effort={effort}
        permissions={chat.permissions} permissionProfiles={profiles} models={remote.models}
        activeTurnId={chat.activeTurnId} {...(chat.contextUsage ? { contextUsage: chat.contextUsage } : {})}
        disabled={!remote.connected || Boolean(chat.closing || chat.unavailable)}
        placeholder="和 Codex 一起工作" skillScope={chat.cwd ?? ''} hasSavedThread={false} mode={chat.mode}
        loadSkills={() => remote.listSkills(chat.cwd)}
        onModelChange={model => onPatch({ model, effort: resolveReasoningEffort(remote.models.find(entry => entry.model === model), effort) })}
        onEffortChange={value => onPatch({ effort: value })}
        onPermissionsChange={async permissions => onPatch({ permissions })}
        onSubmit={(text, attachments, skills) => onSend(turnInput(text, attachments, skills))}
        onStop={async () => {
          if (chat.threadId && chat.activeTurnId) await remote.interruptTurn(chat.threadId, chat.activeTurnId);
        }}
        onError={onError}
        onCommand={async (command, argument) => {
          if (command === 'new') onNew();
          else if (command === 'plan') {
            const available = await remote.listModes();
            const mode = argument === 'off' ? 'default' : argument || chat.mode === 'default' ? 'plan' : 'default';
            if (!available.data.some(entry => entry.mode === mode)) throw new Error('当前 Codex 未提供该模式。');
            onPatch({ mode });
          } else if (command === 'status' || command === 'mcp') setDialog({ type: command });
          else throw new Error('此命令需要在主聊天中执行。');
        }} />
    </div>
    {dialog && <CommandDialog state={dialog} status={[
      { label: '聊天', value: chat.title }, { label: '模型', value: modelInfo?.displayName ?? chat.model },
      { label: '推理强度', value: effort }, { label: '权限', value: permissionLabel(chat.permissions) },
      { label: '工作目录', value: chat.cwd ?? '' }
    ]} loadMcp={() => remote.listMcp(chat.threadId)} onReview={async () => {}}
      onClose={() => setDialog(null)} />}
  </div></PreviewLinks>;
}
