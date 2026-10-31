import { BrainCircuit, CheckCircle2, ChevronDown, CircleAlert, FileCode2, FoldVertical, Globe2, Image, LoaderCircle, Play, TerminalSquare } from 'lucide-react';
import { memo, useId, useMemo, useState } from 'react';
import { useHistoryDetails } from '../history-details';
import { localImageSource } from '../markdown-media';
import { itemKey } from '../remote-state';
import type { ThreadItem } from '../types';
import { isActivityIssue, type TimelineEntry } from '../timeline-model';
import { ImagePreview } from './ImagePreview';
import { MarkdownText } from './MarkdownText';

const INITIAL_ACTIVITY_ITEMS = 60;
const ACTIVITY_PAGE_ITEMS = 120;

export const ActivityGroup = memo(function ActivityGroup({
  entry,
  onInteract
}: {
  entry: Extract<TimelineEntry, { type: 'activity' }>;
  onInteract: () => void;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'issues'>('all');
  const [visibleCount, setVisibleCount] = useState(INITIAL_ACTIVITY_ITEMS);
  const issueCount = entry.failedCount + entry.declinedCount;
  const { label, Icon } = activityPresentation(entry);
  const filteredItems = useMemo(
    () => filter === 'issues' ? entry.items.filter(isActivityIssue) : entry.items,
    [entry.items, filter]
  );
  const hiddenCount = Math.max(0, filteredItems.length - visibleCount);
  const visibleItems = hiddenCount > 0 ? filteredItems.slice(-visibleCount) : filteredItems;
  const issueLabel = [
    entry.failedCount > 0 ? `${entry.failedCount} 条失败` : '',
    entry.declinedCount > 0 ? `${entry.declinedCount} 条已拒绝` : ''
  ].filter(Boolean).join('，');
  const selectFilter = (value: 'all' | 'issues') => {
    setFilter(value);
    setVisibleCount(INITIAL_ACTIVITY_ITEMS);
  };

  return (
    <section className={`activity-group${open ? ' activity-group--open' : ''}`} onClick={onInteract}>
      <div className="activity-group-header">
        <button
          type="button"
          className="activity-group-toggle"
          data-scroll-anchor={entry.key}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          {entry.running
            ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
            : <Icon size={15} aria-hidden="true" />}
          <span className="activity-group-label">{label}</span>
          <ChevronDown size={13} className="summary-chevron" aria-hidden="true" />
        </button>
        {open && issueCount > 0 && (
          <button
            type="button"
            className="activity-group-issues"
            title={issueLabel}
            aria-label={`查看异常记录：${issueLabel}`}
            aria-controls={bodyId}
            onClick={() => { selectFilter('issues'); setOpen(true); }}
          >
            <CircleAlert size={13} aria-hidden="true" />
            <span>{issueCount} 项异常</span>
          </button>
        )}
      </div>
      {open && (
        <div className="activity-group-body" id={bodyId}>
          {issueCount > 0 && (
            <div className="activity-filters" role="group" aria-label="筛选执行记录">
              <button type="button" aria-pressed={filter === 'all'} onClick={() => selectFilter('all')}>
                全部 <span>{entry.items.length}</span>
              </button>
              <button type="button" aria-pressed={filter === 'issues'} title={issueLabel} onClick={() => selectFilter('issues')}>
                异常 <span>{issueCount}</span>
              </button>
            </div>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="activity-group-more"
              onClick={() => setVisibleCount((current) => current + ACTIVITY_PAGE_ITEMS)}
            >
              显示更早的记录（{hiddenCount}）
            </button>
          )}
          {visibleItems.map((item) => (
            <ActivityItem item={item} running={entry.running} key={itemKey(item)} />
          ))}
        </div>
      )}
    </section>
  );
}, (previous, next) =>
  previous.entry.running === next.entry.running &&
  previous.entry.failedCount === next.entry.failedCount &&
  previous.entry.declinedCount === next.entry.declinedCount &&
  previous.onInteract === next.onInteract &&
  previous.entry.items.length === next.entry.items.length &&
  previous.entry.items.every((item, index) => item === next.entry.items[index])
);

function activityPresentation(entry: Extract<TimelineEntry, { type: 'activity' }>) {
  const presentations = {
    tool: { Icon: TerminalSquare, label: '调用了工具', running: '正在调用工具' },
    file: { Icon: FileCode2, label: '编辑了文件', running: '正在编辑文件' },
    command: { Icon: TerminalSquare, label: '运行了命令', running: '正在运行命令' },
    search: { Icon: Globe2, label: '已搜索网页', running: '正在搜索网页' },
    image: { Icon: Image, label: `已查看 ${entry.items.length} 张图像`, running: '正在查看图片' },
    reasoning: { Icon: BrainCircuit, label: '思考过程', running: '正在思考' }
  };
  const presentation = presentations[entry.kind];
  const latest = [...entry.items].reverse().find(item => 'status' in item && item.status === 'inProgress');
  const activeKind = latest?.type === 'fileChange' ? 'file' : latest?.type === 'webSearch' ? 'search'
    : latest?.type === 'commandExecution' ? 'command' : latest ? entry.kind : 'reasoning';
  return { Icon: presentation.Icon, label: entry.running ? presentations[activeKind].running
    : (['tool', 'file', 'command', 'search', 'image'] as const).filter(kind => entry.kinds.includes(kind))
      .map(kind => presentations[kind].label).join('、') };
}

export const ActivityItem = memo(function ActivityItem({ item: summary, running }: { item: ThreadItem; running: boolean }) {
  const [open, setOpen] = useState(false);
  const { item, loading, error, retry } = useHistoryDetails(summary, open);
  const detailNotice = loading ? <p role="status">正在加载执行详情…</p> : error
    ? <p role="alert">{error} <button type="button" className="text-button" onClick={retry}>重试</button></p> : null;
  const status = 'status' in item
    ? item.status === 'inProgress' && !running ? 'ended' : item.status
    : undefined;
  const anchorProps = { 'data-scroll-anchor': itemKey(item) };
  const detailProps = { ...anchorProps,
    onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open) };
  if (item.type === 'agentMessage') {
    return <div className="activity-commentary markdown" {...anchorProps}><MarkdownText text={item.text} assistant /></div>;
  }
  if (item.type === 'reasoning') {
    return (
      <details className="activity-row activity-row--reasoning" {...detailProps}>
        <summary>
          <BrainCircuit size={15} aria-hidden="true" />
          <span>推理过程</span>
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body reasoning-body">
          {[...item.summary, ...item.content].map((part, index) => (
            <p key={index}>{part}</p>
          ))}
        </div>}
      </details>
    );
  }

  if (item.type === 'commandExecution') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          {status === 'inProgress' ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : status === 'failed' ? (
            <CircleAlert size={15} aria-hidden="true" />
          ) : (
            <TerminalSquare size={15} aria-hidden="true" />
          )}
          <span className="activity-command-preview" title={item.command}>{item.command.trim().replace(/\s+/g, ' ') || '命令执行'}</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body">
          {detailNotice}
          <pre className="command-block">{item.command}</pre>
          {item.aggregatedOutput && <pre className="output-block">{item.aggregatedOutput}</pre>}
          {(item.exitCode !== null || item.durationMs !== null) && (
            <div className="activity-meta">
              {item.exitCode !== null && <span>Exit {item.exitCode}</span>}
              {item.durationMs !== null && <span>{formatDuration(item.durationMs)}</span>}
            </div>
          )}
        </div>}
      </details>
    );
  }

  if (item.type === 'fileChange') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          {item.status === 'completed' ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <FileCode2 size={15} aria-hidden="true" />
          )}
          <span>文件变更</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body file-list">
          {detailNotice}
          {item.changes?.map((change, index) => (
            <div className="file-change" key={`${change.path}-${index}`}>
              <code>{change.path}</code>
              {change.diff && <pre className="output-block">{change.diff}</pre>}
            </div>
          ))}
        </div>}
      </details>
    );
  }

  if (item.type === 'plan') {
    return (
      <div className="plan-row" {...anchorProps}>
        <Play size={15} aria-hidden="true" />
        <div>
          <strong>执行计划</strong>
          <p>{item.text}</p>
        </div>
      </div>
    );
  }

  if (item.type === 'mcpToolCall') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          <TerminalSquare size={15} aria-hidden="true" />
          <span>{item.server}/{item.tool}</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body">
          {detailNotice ?? <pre className="output-block">{JSON.stringify(item.result ?? item.error ?? item.arguments, null, 2)}</pre>}
        </div>}
      </details>
    );
  }

  if (item.type === 'dynamicToolCall') {
    return (
      <details className="activity-row" {...detailProps}>
        <summary>
          <TerminalSquare size={15} aria-hidden="true" />
          <span>{item.tool}</span>
          <StatusBadge status={status!} />
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true" />
        </summary>
        {open && <div className="activity-body">
          {detailNotice ?? <pre className="output-block">{JSON.stringify(item.contentItems ?? item.arguments, null, 2)}</pre>}
        </div>}
      </details>
    );
  }

  if (item.type === 'webSearch') {
    return (
      <div className="activity-row activity-row--static" {...anchorProps}>
        <Globe2 size={15} aria-hidden="true" />
        <span>网页搜索</span>
        {item.query && <code>{item.query}</code>}
      </div>
    );
  }

  if (item.type === 'imageView') {
    return (
      <figure className="activity-image" {...anchorProps}>
        <ImagePreview src={localImageSource(item.path)} />
      </figure>
    );
  }

  if (item.type === 'imageGeneration') {
    return (
      <div className="activity-row activity-row--static" {...anchorProps}>
        <Image size={15} aria-hidden="true" />
        <span>图片生成</span>
      </div>
    );
  }

  if (item.type === 'contextCompaction') {
    return (
      <div className="context-divider" {...anchorProps}>
        <FoldVertical size={15} aria-hidden="true" />
        <span>上下文已自动压缩</span>
      </div>
    );
  }

  return null;
});

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') return null;
  return <span className={`status-badge status-badge--${status}`}>{statusLabel(status)}</span>;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'inProgress':
      return '运行中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'declined':
      return '已拒绝';
    case 'ended':
      return '已结束';
    default:
      return status;
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}
