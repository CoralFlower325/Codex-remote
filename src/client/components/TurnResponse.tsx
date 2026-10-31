import { Check, ChevronRight, Copy, GitFork, MoreHorizontal, Pencil } from 'lucide-react';
import { createPortal } from 'react-dom';
import { memo, useEffect, useId, useMemo, useState } from 'react';
import type { TimelineEntry, TimelineSection } from '../timeline-model';
import type { ThreadItem } from '../types';
import { itemKey } from '../remote-state';
import { elapsedTurnMs, formatWorkDuration, type TurnTiming } from '../../shared/turn-timing';
import { hostNow } from '../host-clock';
import { userMessageText } from '../../shared/user-message';
import { localImageSource } from '../markdown-media';
import { copyText } from '../clipboard';
import { ImagePreview } from './ImagePreview';
import { SubagentRows } from './Subagents';
import { isSubagentItem } from '../subagents';
import { NativeTurnError } from './NativeTurnError';
import { MarkdownText } from './MarkdownText';
import { ActivityGroup, ActivityItem } from './TimelineActivity';
import type { UserMessage } from '../message-edit';

export const ResponseSection = memo(function ResponseSection({ section, timing, active, onInteract, onFork, onError }: {
  section: TimelineSection;
  timing: TurnTiming | undefined;
  active: boolean;
  onInteract: () => void;
  onFork: ((turnId: string) => Promise<void>) | undefined;
  onError: ((error: unknown) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  let finalIndex = -1;
  section.entries.forEach((entry, index) => {
    if (entry.type === 'message' && entry.item.type === 'agentMessage' &&
      entry.item.phase !== 'commentary' && entry.item.phase !== 'partial_answer' &&
      (!entry.item.questions?.length || entry.item.text.trim())) finalIndex = index;
  });
  const finalEntry = section.entries[finalIndex];
  const completed = !active && (timing ? timing.status !== 'inProgress'
    : finalEntry?.type === 'message' && finalEntry.item.completedAtMs != null);
  const finalStartedAtMs = finalEntry?.type === 'message' ? finalEntry.item.startedAtMs ?? null : null;
  const agentItems = useMemo(() => section.entries.flatMap(entry =>
    entry.type === 'event' && isSubagentItem(entry.item) ? [entry.item] : []), [section.entries]);
  const firstAgentKey = section.entries.find(entry => entry.type === 'event' && isSubagentItem(entry.item))?.key;
  const trace = (completed ? section.entries.slice(0, finalIndex < 0 ? undefined : finalIndex) : section.entries)
    .filter(entry => !completed || entry.type !== 'event' || !isSubagentItem(entry.item));
  const answer = completed && finalIndex >= 0 ? section.entries.slice(finalIndex)
    .filter(entry => entry.type !== 'event' || !isSubagentItem(entry.item)) : [];
  const renderEntry = (entry: TimelineEntry) => entry.type === 'activity'
    ? <ActivityGroup entry={entry} onInteract={onInteract} key={entry.key} />
    : entry.type === 'event' ? isSubagentItem(entry.item)
      ? entry.key === firstAgentKey ? <SubagentRows items={agentItems} key={entry.key} /> : null
      : <ActivityItem item={entry.item} running={false} key={entry.key} />
    : <MessageItem item={entry.item} key={entry.key} />;
  return <section className="turn-response" data-turn-id={section.turnId} data-scroll-anchor={`response-${section.key}`}>
    {(timing || active && section.showTiming) && <div className="worked-divider">
      {completed && trace.length > 0 ? <button type="button" className="turn-disclosure" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { onInteract(); setOpen(value => !value); }}>
        <TurnDuration timing={timing} active={false} finalStartedAtMs={finalStartedAtMs} />
        <ChevronRight size={13} className={open ? 'is-open' : ''} aria-hidden="true" />
      </button> : <TurnDuration timing={timing} active={active} finalStartedAtMs={finalStartedAtMs} />}
    </div>}
    {(!completed || open) && <div className="turn-activity" id={bodyId}>{trace.map(renderEntry)}</div>}
    {completed && agentItems.length > 0 && <SubagentRows items={agentItems} />}
    {answer.map(renderEntry)}
    <NativeTurnError turn={timing} />
    {!active && finalIndex >= 0 && <ReplyActions text={section.entries.slice(finalIndex).flatMap(entry =>
      entry.type === 'message' && entry.item.type === 'agentMessage' ? [entry.item.text] : []).join('\n\n')}
      turnId={section.turnId} onFork={onFork} onError={onError} />}
  </section>;
});

function ReplyActions({ text, turnId, onFork, onError }: {
  text: string; turnId: string | undefined;
  onFork: ((turnId: string) => Promise<void>) | undefined; onError: ((error: unknown) => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);
  return <div className="reply-actions">
    <button type="button" className="icon-button" aria-label={copied ? '已复制回复' : '复制回复'}
      title={copied ? '已复制' : '复制回复'} onClick={() => {
        void copyText(text).then(() => setCopied(true)).catch(onError);
      }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    {onFork && turnId && <button type="button" className="icon-button" aria-label="回复操作" title="回复操作"
      disabled={busy} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ left: Math.max(8, Math.min(rect.left, innerWidth - 220)), top: Math.max(8, rect.top - 48) });
      }}><MoreHorizontal size={17} /></button>}
    {menu && createPortal(<>
      <button type="button" className="queue-menu-backdrop" aria-label="关闭回复菜单" onClick={() => setMenu(null)} />
      <div className="queue-menu" role="menu" style={menu}>
        <button type="button" role="menuitem" onClick={() => {
          setMenu(null); setBusy(true);
          void onFork!(turnId!).catch(onError).finally(() => setBusy(false));
        }}><GitFork size={15} />分支到新聊天</button>
      </div>
    </>, document.body)}
  </div>;
}

export function TurnDuration({ timing, active, finalStartedAtMs }: {
  timing: TurnTiming | undefined; active: boolean; finalStartedAtMs?: number | null;
}) {
  const [now, setNow] = useState(hostNow);
  useEffect(() => {
    if (!active || timing?.startedAt == null || finalStartedAtMs != null) return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearInterval(timer);
      setNow(hostNow());
      timer = document.visibilityState === 'hidden' ? undefined
        : window.setInterval(() => setNow(hostNow()), 1000);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [active, timing?.startedAt, finalStartedAtMs]);
  const duration = timing ? elapsedTurnMs(active ? { ...timing, status: 'inProgress' } : timing, now, finalStartedAtMs) : null;
  const working = active && finalStartedAtMs == null;
  const text = duration === null ? (working ? '处理中' : '活动')
    : !active && timing?.status === 'interrupted' ? `你在 ${formatWorkDuration(duration)} 后停止了`
    : working && duration < 1000 ? '处理中' : `${working ? '已处理' : '用时'} ${formatWorkDuration(duration)}`;
  return <span className="turn-duration">{text}</span>;
}

export const MessageItem = memo(function MessageItem({ item, showFull = false, onEdit }: {
  item: ThreadItem; showFull?: boolean; onEdit?: ((item: UserMessage) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (item.type === 'userMessage') {
    const text = (item.content ?? []).filter((entry) => entry.type === 'text')
      .map((entry) => userMessageText(entry.text ?? '')).filter(Boolean).join('\n\n');
    const images = (item.content ?? []).filter((entry) => entry.type === 'image' || entry.type === 'localImage');
    const long = text.length > 900 && !showFull;
    return (
      <article className="message message--user" data-user-key={itemKey(item)} data-turn-id={item.turnId}
        data-scroll-anchor={itemKey(item)}>
        <div className="user-message-body">
          {images.length > 0 && <div className="user-message-attachments" aria-label={`${images.length} 个图片附件`}>
            {images.map((entry, index) => (
              <ImagePreview key={index} src={localImageSource(entry.path ?? entry.url)} alt={`图片附件 ${index + 1}`} />
            ))}
          </div>}
          {text && <div className="user-message-text">{long && !expanded ? `${text.slice(0, 800)}...` : text}</div>}
          {long && (
            <button type="button" className="message-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起消息' : '展开消息'}
            </button>
          )}
        {onEdit && <div className="user-message-actions">
          <button type="button" className="icon-button" aria-label="编辑消息" title="编辑消息" onClick={() => onEdit(item)}>
            <Pencil size={15} />
          </button>
        </div>}
        </div>
      </article>
    );
  }

  if (item.type === 'agentMessage') {
    return (
      <article className={`message message--agent${item.phase === 'commentary' ? ' message--commentary' : ''}`}
        data-scroll-anchor={itemKey(item)}>
        <div className="agent-message-body markdown">
          <MarkdownText text={item.text} assistant />
        </div>
      </article>
    );
  }

  return null;
});

