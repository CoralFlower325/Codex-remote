import {
  Archive, ArchiveRestore, Bell, CalendarClock, ChevronRight, CircleAlert, FolderOpen, FolderPlus,
  LoaderCircle, LogOut, MessageSquare, MessageSquareText, Plus, RefreshCw, Search, Wrench, X
} from 'lucide-react';
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { displayThreadTitle } from '../remote-state';
import type {
  AttentionActions,
  AttentionView,
  ConnectionView,
  DirectoryActions,
  DirectoryView
} from '../remote-contracts';
import type { Thread } from '../types';
import { buildSidebarGroups, connectionLabel } from '../workspace-model';
import { WorkspaceFolderDialog } from './WorkspaceFolderDialog';
import { api } from '../api';
import { NotificationSettings } from './NotificationSettings';
import { AppUpdateDialog } from './AppUpdateDialog';
import { BackendUpdateDialog } from './BackendUpdateDialog';
import { clearUpdateReceipt, takeUpdateReceipt } from '../app-update';
import { PanelBoundary } from './PanelBoundary';

const Automations = lazy(() => import('./Automations').then(module => ({ default: module.Automations })));

export type SidebarView = Pick<ConnectionView, 'status' | 'connected' | 'chatTransport'> &
  Pick<DirectoryView, 'threads' | 'threadsLoading' | 'models' | 'projects' | 'showArchived'> &
  Pick<AttentionView, 'questionCounts' | 'serverRequests'> &
  Pick<DirectoryActions, 'refreshThreads' | 'toggleArchived' | 'refreshProjects'> &
  Pick<AttentionActions, 'setLastError'>;

interface SidebarProps {
  remote: SidebarView;
  activeThreadCwd?: string | undefined;
  activeThreadId: string | null;
  layout: 'desktop' | 'mobile';
  open: boolean;
  collapsed: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onToggleCollapse: () => void;
  onNewTask: (projectId?: string) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string, archived: boolean) => Promise<void>;
  onLogout: () => void;
}

export function Sidebar({
  remote, activeThreadCwd, activeThreadId, layout, open, collapsed, search, onSearchChange,
  onClose, onNewTask, onSelectThread, onArchiveThread, onLogout
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [connections, setConnections] = useState<{
    publicOrigin: string | null;
    publicOrigins?: string[];
    lanOrigins: string[];
  } | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [backendUpdateOpen, setBackendUpdateOpen] = useState(false);
  const [completedUpdate, setCompletedUpdate] = useState(takeUpdateReceipt);
  const [updateOpen, setUpdateOpen] = useState(() => Boolean(completedUpdate));
  const [expansion, setExpansion] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('sidebar-project-expansion') ?? '{}') as Record<string, boolean>; }
    catch { return {}; }
  });
  const footerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const projectDialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const groups = useMemo(
    () => buildSidebarGroups(remote.threads, remote.projects, deferredSearch, 'all'),
    [remote.projects, remote.threads, deferredSearch]
  );
  const isCollapsed = layout === 'desktop' && collapsed;
  const sections = [
    ...groups.projects.map((group) => ({
      id: group.project.id, name: group.project.name, threads: group.threads, project: true
    })),
    ...(groups.standalone.length ? [{ id: 'tasks', name: remote.showArchived ? '已归档' : '任务', threads: groups.standalone, project: false }] : [])
  ];

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (layout !== 'mobile' || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    sidebarRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus({ preventScroll: true });
  }, [layout, open]);
  useEffect(() => {
    if (projectPickerOpen) projectDialogRef.current?.showModal();
  }, [projectPickerOpen]);
  useEffect(() => {
    if (!accountOpen) return;
    footerRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const controller = new AbortController();
    void api<{ publicOrigin: string | null; publicOrigins?: string[]; lanOrigins: string[] }>('/api/connections', {
      signal: controller.signal, cache: 'no-store'
    }).then(setConnections).catch(() => undefined);
    const dismiss = (event: PointerEvent) => {
      if (!footerRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => { controller.abort(); window.removeEventListener('pointerdown', dismiss); };
  }, [accountOpen]);

  return (
    <aside id="workspace-sidebar" ref={sidebarRef} className={`sidebar${open ? ' sidebar--open' : ''}${isCollapsed ? ' sidebar--collapsed' : ''}`}
      aria-label="项目与任务" aria-hidden={(layout === 'mobile' && !open) || isCollapsed}
      inert={(layout === 'mobile' && !open) || isCollapsed}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.target instanceof Element && event.target.closest('dialog[open]')) return;
        if (event.key === 'Escape') {
          setAccountOpen(false); setSearchOpen(false);
          if (layout === 'mobile') onClose();
        }
        if (event.key === 'Tab' && layout === 'mobile' && open) {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href]')];
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault(); controls.at(-1)?.focus();
          } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
            event.preventDefault(); controls[0]?.focus();
          }
        }
      }}>
      <div className="sidebar-top">
        <div className="sidebar-mode-row">
          <div className="sidebar-product"><strong>Codex</strong></div>
          <button type="button" className="icon-button sidebar-toolbar-button" aria-label="搜索任务"
            title="搜索任务" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}>
            <Search size={16} />
          </button>
        </div>
        {searchOpen && (
          <div className="sidebar-search-panel">
            <Search size={15} />
            <input ref={searchRef} value={search} onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索任务" aria-label="搜索任务" />
            <button type="button" className="icon-button icon-button--small" aria-label="关闭搜索"
              onClick={() => { onSearchChange(''); setSearchOpen(false); }}><X size={14} /></button>
          </div>
        )}
        <button type="button" className="sidebar-row new-chat-row" onClick={() => onNewTask()}>
          <Plus size={16} /><span>新聊天</span>
        </button>
        <button type="button" className="sidebar-row new-chat-row" onClick={() => setAutomationsOpen(true)}>
          <CalendarClock size={16} /><span>自动任务</span>
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-project-heading"><button type="button" className="sidebar-row sidebar-projects-button" onClick={() => setProjectPickerOpen(true)}>
          <FolderOpen size={16} /><span>项目</span>
        </button><button type="button" className="icon-button" aria-label="添加工作区" title="添加工作区"
          onClick={() => setFolderDialogOpen(true)}><FolderPlus size={16} /></button></div>
        <nav aria-label="项目和任务">
          {remote.threadsLoading && remote.threads.length === 0 && (
            <div className="sidebar-skeleton" aria-label="正在加载任务"><span /><span /><span /></div>
          )}
          {sections.map((section) => {
            const expanded = Boolean(deferredSearch) || (expansion[section.id] ??
              (section.threads.some((thread) => thread.id === activeThreadId) || section.id === 'tasks'));
            return (
              <section className="project-group" key={section.id}>
                <button type="button" className="sidebar-project-row" aria-expanded={expanded}
                  onClick={() => setExpansion((current) => {
                    const next = { ...current, [section.id]: !expanded };
                    try { localStorage.setItem('sidebar-project-expansion', JSON.stringify(next)); } catch { /* Optional preference. */ }
                    return next;
                  })}>
                  {section.project ? <FolderOpen size={16} /> : <MessageSquare size={16} />}
                  <span>{section.name}</span><ChevronRight size={11} className="sidebar-project-chevron" />
                </button>
                {expanded && section.threads.map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} active={thread.id === activeThreadId}
                    questionCount={(remote.questionCounts?.[thread.id] ?? 0) + remote.serverRequests.filter(request =>
                      request.params.threadId === thread.id && request.method === 'item/tool/requestUserInput').length}
                    needsAttention={remote.serverRequests.some((request) => request.params.threadId === thread.id &&
                      request.method !== 'item/tool/requestUserInput')}
                    onArchive={() => onArchiveThread(thread.id, !remote.showArchived)}
                    onError={error => remote.setLastError(error instanceof Error ? error.message : String(error))}
                    onClick={() => onSelectThread(thread.id)} />
                ))}
              </section>
            );
          })}
          {groups.total === 0 && !remote.threadsLoading && <div className="sidebar-empty">{search ? '没有匹配的任务' : '还没有任务'}</div>}
        </nav>
      </div>
      <div className="sidebar-footer" ref={footerRef}>
        {accountOpen && (
          <div className="account-menu" role="menu" aria-label="设置" onKeyDown={event => {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
            const index = controls.indexOf(document.activeElement as HTMLElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
                : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
              controls[next]?.focus();
            } else if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); setAccountOpen(false);
              footerRef.current?.querySelector<HTMLButtonElement>('.account-button')?.focus();
            }
          }}>
            <div className="account-menu-status"><span className={`connection-dot connection-dot--${remote.status}`} />{connectionLabel(remote.status)}</div>
            <button type="button" role="menuitem" onClick={() => {
              setAccountOpen(false);
              void remote.refreshThreads().catch((error: Error) => remote.setLastError(error.message));
            }}><RefreshCw size={15} /><span>刷新任务</span></button>
            <button type="button" role="menuitem" onClick={() => {
              setAccountOpen(false);
              void remote.toggleArchived().catch((error: Error) => remote.setLastError(error.message));
            }}><Archive size={15} /><span>{remote.showArchived ? '返回所有任务' : '已归档任务'}</span></button>
            {(connections?.publicOrigins?.length
              ? connections.publicOrigins
              : connections?.publicOrigin ? [connections.publicOrigin] : [])
              .filter(origin => origin !== location.origin)
              .map(origin => (
                <a className="connection-link" href={origin} key={origin}>
                  {origin === connections?.publicOrigin
                    ? '公网连接'
                    : `公网备用 · ${new URL(origin).host}`}
                </a>
              ))}
            {connections?.lanOrigins.filter(origin => origin !== location.origin).map(origin =>
              <a className="connection-link" href={origin} key={origin}>局域网 · {new URL(origin).host}</a>)}
            <div className="account-menu-separator" />
            <button type="button" role="menuitem" onClick={() => {
              setAccountOpen(false); setBackendUpdateOpen(true);
            }}><RefreshCw size={15} /><span>检查 Remote 更新</span></button>
            <button type="button" role="menuitem" onClick={() => {
              setAccountOpen(false); setUpdateOpen(true);
            }}><RefreshCw size={15} /><span>刷新版本</span></button>
            <button type="button" role="menuitem" onClick={() => {
              setAccountOpen(false); setNotificationsOpen(true);
            }}><Bell size={15} /><span>消息通知</span></button>
            <button type="button" role="menuitem" onClick={onLogout}><LogOut size={15} /><span>退出登录</span></button>
          </div>
        )}
        <button type="button" className="account-button" aria-label="设置" aria-haspopup="menu"
          aria-expanded={accountOpen} onClick={() => setAccountOpen(!accountOpen)}>
          <Wrench size={16} /><span>设置</span>
          <span className="account-version">{import.meta.env.VITE_APP_VERSION}</span>
        </button>
      </div>
      {projectPickerOpen && (
        <dialog ref={projectDialogRef} className="project-dialog" aria-label="选择项目"
          onClose={() => setProjectPickerOpen(false)}>
          <header><strong>项目</strong><button type="button" className="icon-button" aria-label="关闭项目"
            onClick={() => projectDialogRef.current?.close()}><X size={18} /></button></header>
          {remote.projects.map((project) => (
            <button type="button" className="project-dialog-row" key={project.id} onClick={() => {
              projectDialogRef.current?.close(); onNewTask(project.id);
            }}><FolderOpen size={18} /><span><strong>{project.name}</strong><small>{project.roots[0]?.path}</small></span><Plus size={16} /></button>
          ))}
          <button type="button" className="project-dialog-row" onClick={() => {
            projectDialogRef.current?.close(); setFolderDialogOpen(true);
          }}><FolderPlus size={18} /><span>添加工作区</span></button>
        </dialog>
      )}
      {folderDialogOpen && <WorkspaceFolderDialog projects={remote.projects} connected={remote.connected}
        transport={remote.chatTransport} initialCwd={activeThreadCwd} refreshProjects={remote.refreshProjects}
        onSelect={onNewTask} onClose={() => setFolderDialogOpen(false)} />}
      {notificationsOpen && <NotificationSettings onClose={() => setNotificationsOpen(false)} />}
      {automationsOpen && <PanelBoundary><Suspense fallback={null}><Automations models={remote.models} projects={remote.projects}
        onClose={() => setAutomationsOpen(false)}
        onOpenThread={(threadId) => { onSelectThread(threadId); if (layout === 'mobile') onClose(); }} /></Suspense></PanelBoundary>}
      <BackendUpdateDialog open={backendUpdateOpen} onClose={() => setBackendUpdateOpen(false)} />
      {updateOpen && <AppUpdateDialog completed={completedUpdate} onClose={() => {
        setUpdateOpen(false); setCompletedUpdate(null); clearUpdateReceipt();
      }} />}
    </aside>
  );
}

function ThreadRow({ thread, active, needsAttention, questionCount, onClick, onArchive, onError }: {
  thread: Thread; active: boolean; needsAttention: boolean; questionCount: number; onClick: () => void;
  onArchive: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const running = thread.status.type === 'active';
  return (
    <div className="thread-row-container"><button type="button" className={`thread-row${active ? ' thread-row--active' : ''}`} onClick={onClick}
      aria-current={active ? 'page' : undefined} title={questionCount ? `${displayThreadTitle(thread)} · 等待回答 ${questionCount} 个问题` : displayThreadTitle(thread)} data-thread-id={thread.id}>
      <span className="thread-state" aria-hidden="true">
        {needsAttention ? <CircleAlert size={13} /> : questionCount ? <MessageSquareText size={13} /> : running ? <span className="thread-running-spinner"><LoaderCircle size={12} /></span> : null}
      </span>
      {needsAttention && <span className="sr-only">等待审批：</span>}
      <span className="thread-row-title">{displayThreadTitle(thread)}</span>
      {questionCount > 0 && <span className="thread-question-badge" aria-label={`等待回答 ${questionCount} 个问题`}>待回答</span>}
    </button>
    <button type="button" className="thread-archive icon-button" aria-label={thread.archived ? '恢复聊天' : '归档聊天'}
      title={thread.archived ? '恢复聊天' : '归档聊天'} disabled={busy} onClick={() => {
        setBusy(true); void onArchive().catch(onError).finally(() => setBusy(false));
      }}>{busy ? <LoaderCircle size={14} className="spin" /> : thread.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button></div>
  );
}
