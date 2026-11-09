import { CalendarClock, Check, ChevronRight, Copy, FileText, GitFork, MoreHorizontal, Pencil } from 'lucide-react';
import { createPortal } from 'react-dom';
import { memo, useEffect, useId, useMemo, useState } from 'react';
import type { TimelineEntry, TimelineSection } from '../timeline-model';
import { finalAnswerIndex } from '../timeline-model';
import type { ThreadItem } from '../types';
import { itemKey } from '../remote-state';
import { elapsedTurnMs, formatTurnClockTime, formatWorkDuration, turnClockTimes, type TurnTiming } from '../../shared/turn-timing';
import { hostNow } from '../host-clock';
import { userMessageDisplayText } from '../../shared/user-message';
import { heartbeatResponseText, parseHeartbeatPrompt, parseHeartbeatResponse } from '../../shared/heartbeat';
import { localImageSource } from '../markdown-media';
import { copyText } from '../clipboard';
import { ImagePreview } from './ImagePreview';
import { SubagentRows } from './Subagents';
import { isSubagentItem } from '../subagents';
import { NativeTurnError } from './NativeTurnError';
import { MarkdownText } from './MarkdownText';
import { ActivityGroup, ActivityItem } from './TimelineActivity';
import type { UserMessage } from '../message-edit';
import { documentReferences } from '../../shared/document-input';
import { PreviewLink } from './PreviewLinks';

export const ResponseSection = memo(function ResponseSection({
  section, timing, finalStartedAtMs, finalAnswer, hasTrace, showError, open, onToggleTurn, active, heartbeatTurn = false, threadIdle = false, onInteract, onFork, onError
}: {
  section: TimelineSection;
  timing: TurnTiming | undefined;
  finalStartedAtMs: number | null;
  finalAnswer?: ThreadItem | undefined;
  hasTrace: boolean;
  showError: boolean;
  open: boolean;
  onToggleTurn: (turnId: string) => void;
  active: boolean;
  heartbeatTurn?: boolean;
  threadIdle?: boolean;
  onInteract: () => void;
  onFork: ((turnId: string) => Promise<void>) | undefined;
  onError: ((error: unknown) => void) | undefined;
}) {
  const bodyId = useId();
  const finalIndex = finalAnswerIndex(section.entries);
  const finalEntry = section.entries[finalIndex];
  const turnFinal = finalAnswer ?? (finalEntry?.type === 'message' ? finalEntry.item : undefined);
  // Native final-answer records can omit completion timestamps. A verified idle
  // thread can fold their process before timings arrive; a streaming final cannot.
  const completed = !active && (timing ? timing.status !== 'inProgress'
    : turnFinal && (turnFinal.completedAtMs != null ||
        threadIdle && turnFinal.type === 'agentMessage' && turnFinal.phase === 'final_answer'));
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
    : <MessageItem item={entry.item} streamingHeartbeat={active && heartbeatTurn} key={entry.key} />;
  return <section className="turn-response" data-turn-id={section.turnId} data-scroll-anchor={`response-${section.key}`}>
    {section.showTiming && (timing || active || completed) && <div className="worked-divider">
      {completed && hasTrace && section.turnId ? <button type="button" className="turn-disclosure" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { onInteract(); onToggleTurn(section.turnId!); }}>
        <TurnDuration timing={timing} active={false} finalStartedAtMs={finalStartedAtMs} />
        <ChevronRight size={13} className={open ? 'is-open' : ''} aria-hidden="true" />
      </button> : <TurnDuration timing={timing} active={active} finalStartedAtMs={finalStartedAtMs} />}
    </div>}
    {(!completed || open) && <div className="turn-activity" id={bodyId}>{trace.map(renderEntry)}</div>}
    {completed && agentItems.length > 0 && <SubagentRows items={agentItems} />}
    {answer.map(renderEntry)}
    {showError && <NativeTurnError turn={timing} />}
    {!active && finalIndex >= 0 && <ReplyActions text={section.entries.slice(finalIndex).flatMap(entry =>
      entry.type === 'message' && entry.item.type === 'agentMessage' ? [heartbeatResponseText(entry.item.text)] : []).join('\n\n')}
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
  const clock = timing ? turnClockTimes(timing) : null;
  return <>
    <span className="turn-duration">{text}</span>
    {clock?.startMs != null && <span className="turn-clock">开始 {formatTurnClockTime(clock.startMs, now)}
      {clock.endMs != null && <> · 结束 {formatTurnClockTime(clock.endMs, now)}</>}</span>}
  </>;
}

export const MessageItem = memo(function MessageItem({ item, showFull = false, streamingHeartbeat = false, onEdit }: {
  item: ThreadItem; showFull?: boolean; streamingHeartbeat?: boolean; onEdit?: ((item: UserMessage) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (item.type === 'userMessage') {
    const text = userMessageDisplayText(item.content ?? []);
    const heartbeat = parseHeartbeatPrompt(text);
    const displayText = heartbeat ? heartbeat.instructions : text;
    const images = (item.content ?? []).filter((entry) => entry.type === 'image' || entry.type === 'localImage');
    const documents = documentReferences(item.content ?? []);
    const long = displayText.length > 900 && !showFull;
    return (
      <article className={`message message--user${item.optimistic ? ' message--optimistic' : ''}`}
        data-user-key={itemKey(item)} data-turn-id={item.turnId}
        data-scroll-anchor={itemKey(item)}>
        <div className="user-message-body">
          {item.optimistic && <div className="user-message-status" role="status">
            {item.optimistic === 'sending' ? '正在引导当前任务…' : '等待原生确认…'}
          </div>}
          {heartbeat && <div className="automation-run-label"><CalendarClock size={12} aria-hidden="true" />由自动任务发送</div>}
          {images.length > 0 && <div className="user-message-attachments" aria-label={`${images.length} 个图片附件`}>
            {images.map((entry, index) => (
              <ImagePreview key={index} src={localImageSource(entry.path ?? entry.url)} alt={`图片附件 ${index + 1}`} />
            ))}
          </div>}
          {documents.length > 0 && <div className="user-document-attachments" aria-label={`${documents.length} 个 PDF 附件`}>
            {documents.map(document => <PreviewLink className="user-document-attachment" href={document.path}
              key={document.path} title={document.path}><FileText size={18} aria-hidden="true" /><span>{document.name}</span></PreviewLink>)}
          </div>}
          {displayText && <div className="user-message-text">{long && !expanded ? `${displayText.slice(0, 800)}...` : displayText}</div>}
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
    const heartbeat = parseHeartbeatResponse(item.text);
    const quiet = heartbeat?.decision === 'DONT_NOTIFY';
    const displayText = heartbeatResponseText(item.text, streamingHeartbeat);
    if (!displayText && streamingHeartbeat) return null;
    return (
      <article className={`message message--agent${item.phase === 'commentary' ? ' message--commentary' : ''}${quiet ? ' message--automation-quiet' : ''}`}
        data-scroll-anchor={itemKey(item)}>
        {quiet && <div className="automation-run-label automation-run-label--agent"><CalendarClock size={12} aria-hidden="true" />自动任务 · 无需通知</div>}
        <div className="agent-message-body markdown">
          <MarkdownText text={displayText} assistant />
        </div>
      </article>
    );
  }

  return null;
});

