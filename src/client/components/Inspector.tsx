import {
  AlignJustify, ChevronDown, ChevronsDownUp, ChevronsUpDown, Columns2,
  Bot, FileCode2, Folder, GitBranch, TerminalSquare, WrapText, X, Plus, MessageCirclePlus, Maximize2, Minimize2
} from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { itemKey } from '../remote-state';
import { HistoryThreadContext, useHistoryDetails } from '../history-details';
import { buildReviewTurns, splitDiffLines, type DiffLine, type ReviewFile } from '../review-model';
import type { Thread, ThreadItem } from '../types';
import type { RemoteState } from '../useRemote';
import type { ChatInput } from '../queued-messages';
import { useSideChats } from '../useSideChats';
import { resolveReasoningEffort } from '../workspace-model';
import { SideChatView } from './SideChatView';
import type { PreviewTarget } from '../../shared/file-preview';
import { previewLabel } from '../preview-links';
import { PreviewLink } from './PreviewLinks';
import type { useSubagentChats } from '../useSubagentChats';
import { SubagentChatView } from './SubagentChatView';
import { SubagentRows } from './Subagents';
import { PanelBoundary } from './PanelBoundary';

const FilePreview = lazy(() => import('./FilePreview'));

interface InspectorProps {
  open: boolean;
  thread: Thread | null;
  items: ThreadItem[];
  onClose: () => void;
  layout: 'desktop' | 'mobile';
  view: 'launcher' | 'changes' | 'activity' | 'files';
  remote: RemoteState;
  sideChatRequest: { id: number; input?: ChatInput; chatId?: string } | null;
  previewRequest: { id: number; target: PreviewTarget } | null;
  cwd?: string | undefined;
  subagentChats: ReturnType<typeof useSubagentChats>;
  subagentRequest: { id: number; threadId: string } | null;
  sideChats: ReturnType<typeof useSideChats>;
}

export function Inspector({ open, thread, items, onClose, layout, view, remote, sideChatRequest, previewRequest, cwd,
  subagentChats, subagentRequest, sideChats }: InspectorProps) {
  const [tab, setTab] = useState<string>('changes');
  const [expanded, setExpanded] = useState(false);
  const [previews, setPreviews] = useState<Array<{ id: string; target: PreviewTarget }>>([]);
  const inspectorRef = useRef<HTMLElement>(null);
  useEffect(() => { setTab(view); }, [view]);
  useEffect(() => {
    if (!sideChatRequest) return;
    if (sideChatRequest.chatId) setTab(sideChatRequest.chatId);
    else addSideChat(sideChatRequest.input);
  }, [sideChatRequest]);
  useEffect(() => { if (subagentRequest) setTab(`agent-${subagentRequest.threadId}`); }, [subagentRequest]);
  useEffect(() => {
    if (!previewRequest) return;
    const target = previewRequest.target;
    const id = `preview-${encodeURIComponent(target.kind === 'file' ? target.path : target.url)}`;
    setPreviews(current => current.some(preview => preview.id === id)
      ? current.map(preview => preview.id === id ? { id, target } : preview) : [...current, { id, target }]);
    setTab(id);
  }, [previewRequest]);
  useEffect(() => {
    inspectorRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab, open]);
  function addSideChat(input?: ChatInput) {
    const model = thread?.model || remote.models.find(entry => entry.isDefault)?.model || remote.models[0]?.model || '';
    const id = sideChats.add({
      model, effort: resolveReasoningEffort(remote.models.find(entry => entry.model === model), thread?.reasoningEffort ?? ''),
      permissions: thread?.permissionProfile || '', ...((thread?.cwd || cwd) ? { cwd: (thread?.cwd || cwd)! } : {}),
      ...(thread && items.length ? { sourceThreadId: thread.id } : {}),
      ...(thread?.projectId ? { projectId: thread.projectId } : {}),
      ...(input ? { initialInput: input } : {})
    });
    setTab(id);
  }
  useEffect(() => {
    if (!open || layout !== 'mobile') return;
    const previous = document.activeElement as HTMLElement | null;
    inspectorRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus({ preventScroll: true });
  }, [open, layout]);

  const commands = items.filter((item) => item.type === 'commandExecution');
  const changedPaths = [...new Set(items.flatMap((item) => item.type === 'fileChange' ? item.changes.map((change) => change.path) : []))];
  const tabs: Array<{ id: string; label: string }> = [
    ...(tab === 'launcher' ? [{ id: 'launcher', label: '新标签页' }] : []),
    ...(tab === 'changes' || changedPaths.length ? [{ id: 'changes', label: `审阅 ${changedPaths.length}` }] : []),
    ...(tab === 'activity' ? [{ id: 'activity' as const, label: '命令记录' }] : []),
    ...(tab === 'files' ? [{ id: 'files' as const, label: '文件' }] : []),
    ...(tab === 'agents' || subagentChats.directory.length || items.some(item =>
      item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall' && item.receiverThreadIds.length > 0)
      ? [{ id: 'agents', label: '子智能体' }] : []),
    ...sideChats.chats.map(chat => ({ id: chat.id, label: chat.title })),
    ...subagentChats.chats.map(chat => ({ id: `agent-${chat.id}`, label: chat.thread?.agentNickname || chat.agent.name })),
    ...previews.map(preview => ({ id: preview.id, label: previewLabel(preview.target) }))
  ];
  return (
    <HistoryThreadContext.Provider value={thread?.id ?? null}>
      {open && <button type="button" className="inspector-backdrop" aria-label="关闭检查器" onClick={onClose} tabIndex={-1} />}
      <aside id="workspace-inspector" hidden={!open} className={`inspector${expanded ? ' inspector--expanded' : ''}`}
        ref={inspectorRef} aria-label="任务检查器"
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || layout !== 'mobile' || !event.currentTarget.contains(event.target as Node)) return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, select, summary')]
            .filter(control => control.getClientRects().length);
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault(); controls.at(-1)?.focus();
          } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
            event.preventDefault(); controls[0]?.focus();
          }
        }}>
        <header className="inspector-head">
          <div className="inspector-tabs" role="tablist" aria-label="检查器视图">
            {tabs.map(({ id, label }) => (
              <div key={id} className={`inspector-tab${tab === id ? ' is-active' : ''}`}>
              <button type="button" role="tab" aria-selected={tab === id}
                id={`inspector-tab-${id}`} aria-controls={subagentChats.chats.some(chat => `agent-${chat.id}` === id) ? `subagent-${id}`
                  : sideChats.chats.some(chat => chat.id === id) ? `side-chat-${id}`
                  : previews.some(preview => preview.id === id) ? `file-${id}` : 'inspector-content'}
                className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
                {sideChats.chats.some(chat => chat.id === id) && <MessageCirclePlus size={14} aria-hidden="true" />}
                {previews.some(preview => preview.id === id) && <FileCode2 size={14} aria-hidden="true" />}
                {subagentChats.chats.some(chat => `agent-${chat.id}` === id) && <Bot size={14} aria-hidden="true" />}
                {label}
              </button>
              {sideChats.chats.some(chat => chat.id === id) && <button type="button" className="inspector-tab-close"
                aria-label={`关闭${label}`} title={`关闭${label}`}
                disabled={sideChats.chats.find(chat => chat.id === id)?.closing} onClick={async () => {
                  const closed = await sideChats.close(id);
                  if (closed && tab === id) setTab('launcher');
                }}><X size={12} /></button>}
              {previews.some(preview => preview.id === id) && <button type="button" className="inspector-tab-close"
                aria-label={`关闭${label}`} title={`关闭${label}`} onClick={() => {
                  setPreviews(current => current.filter(preview => preview.id !== id));
                  if (tab === id) setTab(previews.find(preview => preview.id !== id)?.id ?? 'launcher');
                }}><X size={12} /></button>}
              {subagentChats.chats.some(chat => `agent-${chat.id}` === id) && <button type="button" className="inspector-tab-close"
                aria-label={`关闭子智能体 ${label}`} title={`关闭子智能体 ${label}`} onClick={() => {
                  subagentChats.close(id.slice(6));
                  if (tab === id) setTab('agents');
                }}><X size={12} /></button>}
              </div>
            ))}
          </div>
          <div className="inspector-head-tools">
            <button type="button" className="icon-button" onClick={() => setTab('launcher')} aria-label="新标签页" title="新标签页"><Plus size={16} /></button>
            {layout === 'desktop' && <button type="button" className="icon-button" onClick={() => setExpanded(value => !value)}
              aria-label={expanded ? '还原面板' : '展开面板'} title={expanded ? '还原面板' : '展开面板'}>
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭检查器" title="关闭检查器"><X size={16} /></button>
          </div>
        </header>
        <div hidden={sideChats.chats.some(chat => chat.id === tab) || previews.some(preview => preview.id === tab) ||
          subagentChats.chats.some(chat => `agent-${chat.id}` === tab)} className="inspector-body"
          id="inspector-content" role="tabpanel" aria-labelledby={`inspector-tab-${tab}`}>
          {tab === 'launcher' ? <div className="inspector-launcher">
            <button type="button" onClick={() => addSideChat()}><MessageCirclePlus size={16} />侧边聊天</button>
            <button type="button" onClick={() => setTab('agents')}><Bot size={16} />子智能体</button>
            <button type="button" onClick={() => setTab('changes')}><FileCode2 size={16} />审阅</button>
            <button type="button" onClick={() => setTab('activity')}><TerminalSquare size={16} />命令记录</button>
            <button type="button" onClick={() => setTab('files')}><Folder size={16} />文件</button>
          </div> : !thread ? <EmptyInspector text="选择一个任务" /> : tab === 'agents' ? (
            <>
              {subagentChats.directoryLoading && <div className="file-preview-loading" role="status" aria-label="正在加载子智能体">
                <div className="message-skeleton message-skeleton--long" /></div>}
              {subagentChats.directoryError && <div className="error-banner" role="alert">{subagentChats.directoryError}</div>}
              <SubagentRows items={items} parentId={thread.id} />
              {!subagentChats.directoryLoading && !subagentChats.directoryError &&
                !subagentChats.directory.length && !items.some(item => item.type === 'subAgentActivity' ||
                  item.type === 'collabAgentToolCall' && item.receiverThreadIds.length > 0) && <EmptyInspector text="暂无子智能体" />}
            </>
          ) : tab === 'changes' ? (
            <Review items={items} cwd={thread.cwd} />
          ) : tab === 'activity' ? (
            <div className="inspector-list">
              {commands.length === 0 && <EmptyInspector text="暂无命令记录" />}
              {commands.map((command) => <CommandDetail key={itemKey(command)} command={command} active={open} />)}
            </div>
          ) : (
            <div className="inspector-list">
              <div className="inspector-path-row"><Folder size={15} /><code title={thread.cwd}>{thread.cwd}</code></div>
              {thread.gitInfo?.branch && <div className="inspector-path-row"><GitBranch size={15} /><span>{thread.gitInfo.branch}</span></div>}
              {changedPaths.map((path) => (
                <div className="inspector-path-row" key={path}><FileCode2 size={15} /><PreviewLink href={path}><code title={path}>{displayPath(path, thread.cwd)}</code></PreviewLink></div>
              ))}
            </div>
          )}
        </div>
        {sideChats.chats.map(chat => <div key={chat.id} hidden={tab !== chat.id} className="side-chat-tab"
          role="tabpanel" id={`side-chat-${chat.id}`} aria-labelledby={`inspector-tab-${chat.id}`}>
          <SideChatView chat={chat} remote={remote} layout={layout}
            onPatch={changes => sideChats.patch(chat.id, changes)}
            onSend={input => sideChats.send(chat.id, input)}
            onNew={() => addSideChat()} />
        </div>)}
        {previews.map(preview => <div key={preview.id} hidden={tab !== preview.id} className="file-preview-tab"
          role="tabpanel" id={`file-${preview.id}`} aria-labelledby={`inspector-tab-${preview.id}`}>
          <PanelBoundary key={preview.id}>
            <Suspense fallback={<div className="file-preview-loading" role="status" aria-label="正在加载预览"><div className="message-skeleton message-skeleton--long" /></div>}>
              <FilePreview target={preview.target} active={open && tab === preview.id} />
            </Suspense>
          </PanelBoundary>
        </div>)}
        {subagentChats.chats.map(chat => <div key={chat.id} hidden={tab !== `agent-${chat.id}`} className="side-chat-tab"
          role="tabpanel" id={`subagent-agent-${chat.id}`} aria-labelledby={`inspector-tab-agent-${chat.id}`}>
          <SubagentChatView chat={chat} onLoadEarlier={beforeCommit => subagentChats.load(chat.id, true, beforeCommit)}
            onPrefetchEarlier={() => subagentChats.prefetch(chat.id)}
            onRetry={() => subagentChats.load(chat.id)} />
        </div>)}
      </aside>
    </HistoryThreadContext.Provider>
  );
}

function Review({ items, cwd }: { items: ThreadItem[]; cwd: string }) {
  const turns = useMemo(() => buildReviewTurns(items), [items]);
  const [selectedTurn, setSelectedTurn] = useState('');
  const [mode, setMode] = useState<'unified' | 'split'>(() => localStorage.getItem('review-mode') === 'split' ? 'split' : 'unified');
  const [wrap, setWrap] = useState(() => localStorage.getItem('review-wrap') === 'true');
  const [expanded, setExpanded] = useState(false);
  const turn = turns.find((value) => value.id === selectedTurn) ?? turns[0];
  if (!turn?.files.length) return <EmptyInspector text="暂无文件变更" />;
  const added = turn.files.reduce((count, file) => count + file.added, 0);
  const deleted = turn.files.reduce((count, file) => count + file.deleted, 0);
  return (
    <div className={`review review--${mode}${wrap ? ' review--wrap' : ''}`}>
      <div className="review-toolbar">
        <span className="review-file-count">{turn.files.length} 个文件</span>
        <span className="diff-stat"><span className="diff-added">+{added}</span><span className="diff-deleted">−{deleted}</span></span>
        <button type="button" className="icon-button icon-button--small" title={wrap ? '关闭自动换行' : '自动换行'}
          aria-label="自动换行" aria-pressed={wrap} onClick={() => {
            localStorage.setItem('review-wrap', String(!wrap)); setWrap(!wrap);
          }}><WrapText size={15} /></button>
        <button type="button" className="icon-button icon-button--small" title={mode === 'unified' ? '并排显示' : '统一显示'}
          aria-label="并排显示" aria-pressed={mode === 'split'} onClick={() => {
            const next = mode === 'unified' ? 'split' : 'unified';
            localStorage.setItem('review-mode', next); setMode(next);
          }}>{mode === 'unified' ? <Columns2 size={15} /> : <AlignJustify size={15} />}</button>
        <button type="button" className="icon-button icon-button--small" title={expanded ? '全部折叠' : '全部展开'}
          aria-label={expanded ? '全部折叠' : '全部展开'} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
        </button>
      </div>
      {turns.length > 1 && (
        <label className="review-turn-picker"><span className="sr-only">选择变更轮次</span>
          <select value={turn.id} onChange={(event) => setSelectedTurn(event.target.value)}>
            {turns.map((value, index) => <option key={value.id} value={value.id}>{index === 0 ? '最近一轮变更' : `较早变更 ${index}`}</option>)}
          </select>
        </label>
      )}
      <div className="review-files">
        {turn.files.map((file) => <DiffFile key={`${turn.id}:${file.path}`} file={file} cwd={cwd} mode={mode} expanded={expanded} />)}
      </div>
    </div>
  );
}

const DiffFile = memo(function DiffFile({ file, cwd, mode, expanded }: {
  file: ReviewFile; cwd: string; mode: 'unified' | 'split'; expanded: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  useEffect(() => setOpen(expanded), [expanded]);
  return (
    <section className="diff-file">
      <button type="button" className="diff-file-heading" aria-expanded={open} onClick={() => setOpen(!open)} title={file.path}>
        <ChevronDown size={14} className={open ? '' : 'is-collapsed'} />
        <code>{displayPath(file.path, cwd)}</code>
        <span className="diff-stat"><span className="diff-added">+{file.added}</span><span className="diff-deleted">−{file.deleted}</span></span>
      </button>
      {open && (file.hunks.length === 0 ? (
        <div className="diff-unavailable">无文本差异</div>
      ) : (
        <div className="diff-content" tabIndex={0} role="region" aria-label={`${displayPath(file.path, cwd)} 的代码差异`}>
          {file.hunks.map((hunk, index) => (
            <div className="diff-hunk" key={index}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {mode === 'split' ? splitDiffLines(hunk.lines).map((row, lineIndex) => (
                <div className="diff-split-row" key={lineIndex}>
                  <DiffSide line={row.left} side="old" /><DiffSide line={row.right} side="new" />
                </div>
              )) : hunk.lines.map((line, lineIndex) => (
                <div className={`diff-line diff-line--${line.type}`} key={lineIndex}>
                  <span className="diff-line-number">{line.oldLine}</span>
                  <span className="diff-line-number">{line.newLine}</span>
                  <span className="diff-line-sign">{line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ' '}</span>
                  <code>{line.text || ' '}</code>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
});

function DiffSide({ line, side }: { line: DiffLine | null; side: 'old' | 'new' }) {
  return (
    <div className={`diff-line diff-side${line ? ` diff-line--${line.type}` : ' diff-line--empty'}`}>
      <span className="diff-line-number">{side === 'old' ? line?.oldLine : line?.newLine}</span>
      <span className="diff-line-sign">{line?.type === 'add' ? '+' : line?.type === 'delete' ? '−' : ' '}</span>
      <code>{line?.text || ' '}</code>
    </div>
  );
}

function CommandDetail({ command: summary, active }: { command: Extract<ThreadItem, { type: 'commandExecution' }>; active: boolean }) {
  const [open, setOpen] = useState(false);
  const { item: command, loading, error, retry } = useHistoryDetails(summary, open && active);
  if (command.type !== 'commandExecution') return null;
  return (
    <details className="inspector-activity" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><TerminalSquare size={15} /><code title={command.command}>{command.command}</code></summary>
      {open && loading && <p role="status">正在加载执行详情…</p>}
      {open && error && <p role="alert">{error} <button type="button" onClick={retry}>重试</button></p>}
      {open && command.aggregatedOutput && <pre>{command.aggregatedOutput}</pre>}
    </details>
  );
}

function EmptyInspector({ text }: { text: string }) {
  return <div className="inspector-empty"><FileCode2 size={22} /><span>{text}</span></div>;
}

function displayPath(value: string, cwd: string): string {
  const normalized = value.replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
}
