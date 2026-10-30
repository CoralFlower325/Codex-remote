import {
  ArrowUp, Bot, Check, ChevronDown, File, FileText, Folder, GitPullRequest, Globe,
  Link2, LoaderCircle, MessageCircle, Plus, Presentation, RefreshCw, Sheet, X
} from 'lucide-react';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { SubagentsContext, SubagentRows } from './Subagents';
import { collectSubagents } from '../subagents';
import { useThreadSummary } from '../useThreadSummary';
import type { RemoteState } from '../useRemote';
import type { SideChat } from '../useSideChats';
import type { SummaryResource } from '../../shared/thread-summary';
import { PreviewLink } from './PreviewLinks';
import './summary-panel.css';

export function SummaryPanel({ remote, open, pinned, inline, onClose, sideChats, onSideChat, onDraft, onServers }: {
  remote: RemoteState; open: boolean; pinned: boolean; inline: boolean; onClose: () => void;
  sideChats: SideChat[]; onSideChat: (id?: string) => void; onDraft: (text: string) => void; onServers: () => void;
}) {
  const thread = remote.activeThread;
  const summary = useThreadSummary(thread?.id, open && remote.authenticated && !remote.isNewThread, remote.chatTransport);
  const { threads, states } = useContext(SubagentsContext);
  const agents = collectSubagents(remote.items, threads, thread?.id).map(agent =>
    states?.[agent.threadId] ? { ...agent, status: states[agent.threadId]! } : agent);
  const [expandedAgents, setExpandedAgents] = useState(false);
  const [menu, setMenu] = useState<'outputs' | 'sources' | null>(null);
  const [picker, setPicker] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || inline) return;
    previous.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous.current?.focus({ preventScroll: true }); };
  }, [open, inline]);
  useEffect(() => {
    if (!menu) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('.summary-file-picker')) return;
      const buttons = [...(inline ? document.querySelector('.summary-panel--inline') : dialog.current)!
        .querySelectorAll<HTMLButtonElement>('.summary-menu [role="menuitem"]')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        const anchor = buttons[0]?.closest('.summary-menu-anchor')?.querySelector<HTMLButtonElement>(':scope > button');
        setMenu(null); anchor?.focus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.summary-menu-anchor')) setMenu(null);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', keyboard, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keyboard, true); };
  }, [menu, inline]);
  useEffect(() => { setMenu(null); setExpandedAgents(false); setPicker(false); }, [thread?.id, open]);
  if (!open || !thread) return null;
  const create = (text: string) => { setMenu(null); onDraft(text); };
  const content = <>
    <header className="summary-header"><strong>摘要</strong>
      <button type="button" className="icon-button" title="刷新摘要" aria-label="刷新摘要" disabled={summary.loading}
        onClick={summary.refresh}><RefreshCw size={15} className={summary.loading ? 'spin' : ''} /></button>
      <button type="button" className="icon-button" title={pinned ? '取消固定摘要面板' : '关闭摘要'}
        aria-label={pinned ? '取消固定摘要面板' : '关闭摘要'} onClick={onClose}><X size={16} /></button>
    </header>
    <div className="summary-content">
      {summary.data.pullRequests.length > 0 && <SummarySection title="拉取请求">
        <ResourceList rows={summary.data.pullRequests} />
      </SummarySection>}
      <SummarySection title="输出内容" action={<div className="summary-menu-anchor">
        <button type="button" className="icon-button" aria-label="创建文件或站点" title="创建文件或站点"
          aria-expanded={menu === 'outputs'} onClick={() => setMenu(menu === 'outputs' ? null : 'outputs')}><Plus size={17} /></button>
        {menu === 'outputs' && <div className="summary-menu" role="menu" aria-label="创建文件或站点">
          {[
            [FileText, '创建文档', '创建一个文档：'],
            [Presentation, '创建演示文稿', '创建一个演示文稿：'],
            [Sheet, '创建电子表格', '创建一个电子表格：'],
            [Globe, '创建站点', '创建一个网站：']
          ].map(([Icon, label, text]) => {
            const Asset = Icon as typeof FileText;
            return <button type="button" role="menuitem" key={String(label)} onClick={() => create(String(text))}>
              <Asset size={16} />{String(label)}</button>;
          })}
        </div>}
      </div>}>
        <ResourceList rows={summary.data.outputs} />
        {!summary.data.outputs.length && !summary.loading && <button type="button" className="summary-row summary-empty-action"
          onClick={() => setMenu('outputs')}>创建文件或站点</button>}
      </SummarySection>
      {sideChats.length > 0 && <SummarySection title="侧边聊天">
        {sideChats.map(chat => <button type="button" className="summary-row" key={chat.id} title={chat.title}
          onClick={() => onSideChat(chat.id)}>{chat.activeTurnId ? <LoaderCircle size={16} className="spin" /> : <MessageCircle size={16} />}
          <span>{chat.title}</span></button>)}
      </SummarySection>}
      {agents.length > 0 && <SummarySection title="子智能体">
        <button type="button" className="summary-row summary-agents" aria-expanded={expandedAgents}
          onClick={() => setExpandedAgents(value => !value)}>
          <span className="summary-agent-icons">{agents.slice(0, 3).map(agent => <Bot key={agent.threadId} size={16} />)}</span>
          <span>{agents.length} {agents.every(agent => agent.status === 'completed') ? '完成'
            : `${agents.filter(agent => agent.status === 'completed').length} 完成`}</span>
          <ChevronDown size={14} /></button>
        {expandedAgents && <SubagentRows agents={agents} />}
      </SummarySection>}
      <SummarySection title="来源" action={<div className="summary-menu-anchor">
        <button type="button" className="icon-button" title="添加来源" aria-label="添加来源" aria-expanded={menu === 'sources'}
          onClick={() => setMenu(menu === 'sources' ? null : 'sources')}><Plus size={17} /></button>
        {menu === 'sources' && <div className="summary-menu" role="menu" aria-label="添加来源">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setPicker(true); }}><File size={16} />添加文件</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onServers(); }}><Link2 size={16} />MCP 服务器</button>
        </div>}
      </div>}>
        <ResourceList rows={summary.data.sources} />
        {!summary.data.sources.length && !summary.loading && <button type="button" className="summary-row summary-empty-action"
          onClick={() => setMenu('sources')}>添加文件或查看 MCP 服务</button>}
      </SummarySection>
      {summary.loading && <div className="summary-loading" role="status"><LoaderCircle size={15} className="spin" />正在加载摘要…</div>}
      {summary.error && <div className="summary-error" role="alert">{summary.error}
        <button type="button" className="icon-button" aria-label="重试加载摘要" title="重试加载摘要" onClick={summary.refresh}><RefreshCw size={15} /></button></div>}
      {summary.data.nextCursor && !summary.loading && <button type="button" className="summary-row summary-show-all"
        onClick={summary.loadMore}>加载更早的摘要</button>}
    </div>
    {picker && <SourceFilePicker remote={remote} onClose={() => setPicker(false)} onSelect={path => {
      const label = (path.split(/[\\/]/).at(-1) ?? path).replace(/[\\[\]]/g, '\\$&');
      const target = encodeURI(path.replace(/\\/g, '/')).replace(/[()?#]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      setPicker(false); onDraft(`[${label}](${target})`);
    }} />}
  </>;
  return inline ? <aside className="summary-panel summary-panel--inline" aria-label="会话摘要">{content}</aside>
    : <dialog ref={dialog} className="summary-panel summary-panel--overlay" aria-label="会话摘要"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={event => { if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); } }}>
      {content}</dialog>;
}

function SummarySection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="summary-section"><div className="summary-section-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}

function ResourceList({ rows }: { rows: SummaryResource[] }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  return <>
    {(expanded ? rows : rows.slice(0, 3)).map(row => {
      const Icon = row.kind === 'pullRequest' ? GitPullRequest : row.kind === 'file'
        ? /\.pptx?$/i.test(row.target ?? '') ? Presentation : /\.xlsx?$/i.test(row.target ?? '') ? Sheet : FileText
        : row.kind === 'connector' ? Link2 : Globe;
      const content = <><Icon size={16} aria-hidden="true" /><span>{row.label}</span></>;
      return <div className={`summary-resource summary-resource--${row.kind}`} key={row.id}>
        {row.target ? <PreviewLink className="summary-row" href={row.target} title={row.target}>{content}</PreviewLink>
          : <button type="button" className="summary-row" title={row.detail ?? row.label}
            aria-expanded={detail === row.id} onClick={() => setDetail(detail === row.id ? null : row.id)}>{content}</button>}
        {detail === row.id && <p className="summary-resource-detail">{row.detail || row.label}</p>}
      </div>;
    })}
    {rows.length > 3 && <button type="button" className="summary-row summary-show-all" onClick={() => setExpanded(value => !value)}
      aria-expanded={expanded}><Link2 size={16} /><span>{expanded ? '收起' : `查看全部 ${rows.length}`}</span></button>}
  </>;
}

function SourceFilePicker({ remote, onSelect, onClose }: {
  remote: RemoteState; onSelect: (path: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState(remote.activeThread?.cwd ?? '');
  const [path, setPath] = useState(current);
  const [entries, setEntries] = useState<Array<{ fileName: string; isDirectory: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(null);
    void remote.chatTransport.rpc<{ entries: typeof entries }>('fs/readDirectory', { path: current }).then(result => {
      if (!disposed) { setEntries(result.entries); setPath(current); }
    }).catch(failure => { if (!disposed) setError(failure.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [current, remote.chatTransport]);
  return <dialog ref={ref} className="workspace-folder-dialog summary-file-picker" aria-label="选择来源文件"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClose={event => { event.stopPropagation(); onClose(); }}>
    <header><strong>选择来源文件</strong><button type="button" className="icon-button" title="关闭文件选择" aria-label="关闭文件选择"
      onClick={onClose}><X size={17} /></button></header>
    <form className="folder-path" onSubmit={event => { event.preventDefault(); if (path.trim()) setCurrent(path.trim()); }}>
      <button type="button" className="icon-button" aria-label="上一级" title="上一级" disabled={loading || !current}
        onClick={() => {
          const cleaned = current.replace(/[\\/]+$/, '');
          const separator = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
          if (separator >= 0) setCurrent(cleaned.slice(0, separator + 1));
        }}><ArrowUp size={16} /></button>
      <input aria-label="来源文件夹路径" value={path} onChange={event => setPath(event.target.value)} />
      <button type="submit" className="icon-button" disabled={!path.trim()} aria-label="打开文件夹路径" title="打开文件夹路径"><Check size={16} /></button>
    </form>
    <div className="folder-list">{loading ? <LoaderCircle size={18} className="spin" /> : entries.map(entry =>
      <button type="button" key={entry.fileName} onClick={() => {
        const joined = `${current.replace(/[\\/]+$/, '')}/${entry.fileName}`;
        if (entry.isDirectory) setCurrent(joined); else onSelect(joined);
      }}>{entry.isDirectory ? <Folder size={16} /> : <FileText size={16} />}<span>{entry.fileName}</span></button>)}
      {!loading && !error && !entries.length && <p>此文件夹为空</p>}
    </div>
    {error && <p className="folder-error" role="alert">{error}</p>}
  </dialog>;
}
