import {
  CircleAlert,
  Menu,
  PanelRight,
  PanelLeft,
  PanelBottom,
  SlidersHorizontal,
  Info,
  MoreHorizontal,
  Pencil,
  Archive,
  ArchiveRestore,
  RefreshCw,
  Check,
  X
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';

import { api } from './api';
import { QuestionDock } from './components/QuestionDock';
import { ApprovalDock } from './components/ApprovalDock';
import { Composer } from './components/Composer';
import { Inspector } from './components/Inspector';
import { WorkspacePanels } from './components/WorkspacePanels';
import { Sidebar } from './components/Sidebar';
import { ThreadTimeline } from './components/ThreadTimeline';
import { CommandDialog, type CommandDialogState } from './components/CommandDialog';
import { displayThreadTitle } from './remote-state';
import { useRemote } from './useRemote';
import type { ComposerAttachment, SkillInfo, Thread, WorkspaceBootstrap } from './types';
import { layoutForViewport, modelDisplayName, reasoningLabel, resolveReasoningEffort } from './workspace-model';
import { collaborationMode, slashCommands, type SlashCommandId } from './slash-commands';
import { permissionLabel } from '../shared/permissions';
import type { ChatInput } from './queued-messages';
import { editableInterruptedMessage, type UserMessage } from './message-edit';
import { EditMessageDialog } from './components/EditMessageDialog';
import { turnInput } from './slash-commands';
import { QueuedMessages } from './components/QueuedMessages';
import { PreviewLinks } from './components/PreviewLinks';
import { SubagentsContext } from './components/Subagents';
import { useSubagentChats } from './useSubagentChats';
import { subagentChatStatus, type Subagent } from './subagents';
import './subagents.css';
import type { PreviewTarget } from '../shared/file-preview';
import { markStartup } from './startup';
import { unlinkDeviceNotifications } from './push-notifications';
import { toggleInspectorLauncher, type InspectorView } from './inspector-state';
import { GoalStatus } from './components/GoalStatus';
import { SummaryPanel } from './components/SummaryPanel';
import { useSideChats } from './useSideChats';

interface WorkspaceProps {
  authenticated: boolean;
  onAuthExpired: () => void;
  bootstrap: WorkspaceBootstrap | null;
  bootstrapRequest?: Promise<WorkspaceBootstrap | null> | undefined;
  startupError?: string | null;
  onStartupRetry?: () => void;
}

type LayoutMode = 'desktop' | 'mobile';

const TerminalPanel = lazy(() => import('./components/TerminalPanel'));

export function Workspace({ authenticated, onAuthExpired, bootstrap, bootstrapRequest,
  startupError, onStartupRetry }: WorkspaceProps) {
  const remote = useRemote({ authenticated, onAuthExpired, bootstrap, bootstrapRequest });
  useEffect(() => { markStartup('shell'); }, []);
  const layout = useResponsiveLayout();
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>('changes');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [newTaskModel, setNewTaskModel] = useState('');
  const [newTaskEffort, setNewTaskEffort] = useState('');
  const [newTaskPermissions, setNewTaskPermissions] = useState('');
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [newTaskMode, setNewTaskMode] = useState<'default' | 'plan'>('default');
  const [commandDialog, setCommandDialog] = useState<CommandDialogState | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [sideChatRequest, setSideChatRequest] = useState<{ id: number; input?: ChatInput; chatId?: string } | null>(null);
  const sideChats = useSideChats(remote.chatTransport, remote.connected);
  const [summaryPinned, setSummaryPinned] = useState(() => {
    try { return localStorage.getItem('summary-panel-pinned') === 'true'; } catch { return false; }
  });
  const [summaryOverlayOpen, setSummaryOverlayOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const [mainWidth, setMainWidth] = useState(0);
  const summaryInline = layout === 'desktop' && mainWidth >= 1096;
  const summaryOpen = !inspectorOpen && Boolean(remote.activeThread) && (summaryInline ? summaryPinned : summaryOverlayOpen);
  const [draftRequest, setDraftRequest] = useState<{ threadId: string; id: number; text: string } | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => { if (entry) setMainWidth(entry.contentRect.width); });
    if (mainRef.current) observer.observe(mainRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setSummaryOverlayOpen(false); }, [remote.activeThreadId, summaryInline]);
  useEffect(() => { setDraftRequest(null); }, [remote.activeThreadId]);
  function closeSummary() {
    if (summaryInline) {
      setSummaryPinned(false);
      try { localStorage.setItem('summary-panel-pinned', 'false'); } catch { /* Keep the control usable. */ }
    }
    setSummaryOverlayOpen(false);
  }
  function insertSummaryDraft(text: string) {
    if (!remote.activeThreadId) return;
    setDraftRequest(previous => ({ threadId: remote.activeThreadId!, id: (previous?.id ?? 0) + 1, text }));
    setSummaryOverlayOpen(false);
  }
  const [previewRequest, setPreviewRequest] = useState<{ id: number; target: PreviewTarget } | null>(null);
  const [notificationThreadId, setNotificationThreadId] = useState(() =>
    new URLSearchParams(location.search).get('thread'));
  useEffect(() => {
    const openNotification = (event: MessageEvent) => {
      if (event.data?.type === 'notification.open' && typeof event.data.threadId === 'string') {
        setNotificationThreadId(event.data.threadId);
      }
    };
    navigator.serviceWorker?.addEventListener('message', openNotification);
    return () => navigator.serviceWorker?.removeEventListener('message', openNotification);
  }, []);
  useEffect(() => {
    if (!authenticated || !notificationThreadId) return;
    const threadId = notificationThreadId;
    setNotificationThreadId(null);
    const url = new URL(location.href);
    url.searchParams.delete('thread');
    history.replaceState(history.state, '', url);
    setSidebarOpen(false);
    void remote.openThread(threadId).catch(error => remote.setLastError(
      error instanceof Error ? error.message : String(error)));
  }, [authenticated, notificationThreadId, remote.openThread]);
  const subagentChats = useSubagentChats(remote.chatTransport, remote.connected, remote.activeThread?.id);
  const [selectedSubagent, setSelectedSubagent] = useState<{ id: number; threadId: string } | null>(null);
  const openSubagent = useCallback((agent: Subagent) => {
    subagentChats.open(agent);
    setSelectedSubagent(previous => ({ id: (previous?.id ?? 0) + 1, threadId: agent.threadId }));
    setInspectorOpen(true);
    setSummaryOverlayOpen(false);
  }, [subagentChats.open]);
  const subagentsContext = useMemo(() => ({ open: openSubagent,
    states: Object.fromEntries(subagentChats.chats.map(chat => [chat.id, subagentChatStatus(chat)])),
    threads: [...remote.threads, ...subagentChats.directory, ...subagentChats.chats.flatMap(chat => chat.thread ? [chat.thread] : [])]
  }), [openSubagent, remote.threads, subagentChats.directory, subagentChats.chats]);
  const openPreview = useCallback((target: PreviewTarget) => {
    setPreviewRequest(previous => ({ id: (previous?.id ?? 0) + 1, target }));
    setInspectorOpen(true);
    setSummaryOverlayOpen(false);
  }, []);

  const activeThread = remote.activeThread;
  const defaultModel = remote.models.find((model) => model.isDefault) ?? remote.models[0];
  const activeModelInfo =
    remote.models.find((model) => model.model === (activeThread?.model || newTaskModel)) ?? defaultModel;
  const activeEffort = resolveReasoningEffort(
    activeModelInfo,
    activeThread?.reasoningEffort || newTaskEffort
  );
  const effectiveModel = activeThread?.model || newTaskModel || defaultModel?.model || '';
  const effectivePermissions = activeThread?.permissionProfile || newTaskPermissions || remote.defaultPermissionProfile || '';
  const permissionCwd = activeThread?.cwd || remote.projects.find((project) => project.id === selectedProjectId)?.roots[0]?.path;
  const effectiveMode = activeThread ? activeThread.collaborationMode?.mode ?? 'default' : newTaskMode;
  const hasSavedThread = Boolean(activeThread) && !remote.isNewThread && !remote.showArchived && remote.threadReady;
  const commandProps = {
    onCommand: runCommand,
    loadSkills: () => remote.listSkills(permissionCwd),
    skillScope: permissionCwd ?? '',
    hasSavedThread,
    mode: effectiveMode
  };

  useEffect(() => {
    if (!commandNotice) return;
    const timer = window.setTimeout(() => setCommandNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [commandNotice]);

  useEffect(() => {
    if (remote.connected) {
      void remote.refreshPermissions(permissionCwd).catch((error: Error) => remote.setLastError(error.message));
    }
  }, [remote.connected, remote.refreshPermissions, permissionCwd]);

  useEffect(() => {
    if (!newTaskModel && defaultModel) setNewTaskModel(defaultModel.model);
  }, [defaultModel, newTaskModel]);

  useEffect(() => {
    if (!newTaskEffort && defaultModel) {
      setNewTaskEffort(resolveReasoningEffort(defaultModel, defaultModel.defaultReasoningEffort));
    }
  }, [defaultModel, newTaskEffort]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('dialog[open]')) return;
      const inTerminal = event.target instanceof Element && event.target.closest('.terminal-screen');
      if (inTerminal && event.key.toLowerCase() !== 'j') return;
      if ((event.ctrlKey || event.metaKey) && ['n', 'k'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        beginNewTask();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (layout === 'mobile') setSidebarOpen((value) => !value);
        else setSidebarCollapsed((value) => !value);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault(); setTerminalOpen((value) => !value);
      }
      if (event.key === 'Escape') {
        setInspectorOpen(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [layout, remote.showArchived, remote.closeThread, remote.toggleArchived]);

  const showError = (error: unknown) => {
    remote.setLastError(error instanceof Error ? error.message : String(error));
  };

  function beginNewTask(projectId?: string) {
    remote.closeThread();
    if (remote.showArchived) void remote.toggleArchived().catch(showError);
    remote.setLastError(null);
    if (projectId !== undefined) setSelectedProjectId(projectId);
    setSidebarOpen(false);
    setNewTaskMode('default');
    setCommandDialog(null);
    setComposerFocusRequest((value) => value + 1);
  }

  async function selectThread(threadId: string) {
    setSidebarOpen(false);
    setInspectorOpen(false);
    setTaskMenuOpen(false);
    setRenameDraft(null);
    await remote.openThread(threadId).catch(showError);
  }

  async function changeModel(model: string) {
    const info = remote.models.find((entry) => entry.model === model);
    if (!activeThread) {
      setNewTaskModel(model);
      setNewTaskEffort(resolveReasoningEffort(info, newTaskEffort));
      return;
    }
    const effort = resolveReasoningEffort(info, activeThread.reasoningEffort);
    await remote.setThreadSettings(activeThread.id, {
      model, effort,
      ...(activeThread.collaborationMode ? { collaborationMode: collaborationMode(effectiveMode, model, effort) } : {})
    });
  }

  async function changeEffort(effort: string) {
    if (!activeThread) {
      setNewTaskEffort(effort);
      return;
    }
    await remote.setThreadSettings(activeThread.id, {
      effort,
      ...(activeThread.collaborationMode ? { collaborationMode: collaborationMode(effectiveMode, effectiveModel, effort) } : {})
    });
  }

  async function changePermissions(permissions: string) {
    if (!activeThread) {
      setNewTaskPermissions(permissions);
      return;
    }
    await remote.setThreadSettings(activeThread.id, { permissions });
  }

  async function runCommand(command: SlashCommandId, argument: string) {
    const definition = slashCommands.find((entry) => entry.id === command)!;
    if (definition.needsThread && !hasSavedThread) throw new Error('先打开一个已保存的聊天。');
    if (definition.idleOnly && remote.activeTurnId) throw new Error('请等待当前任务结束。');
    if (argument && !['rename', 'review', 'plan'].includes(command)) throw new Error(`/${command} 不接受参数。`);
    remote.setLastError(null);
    if (command === 'new') beginNewTask(activeThread?.projectId ?? selectedProjectId);
    else if (command === 'plan') {
      const mode = argument === 'off' ? 'default' : argument === 'on' || argument ? 'plan' : effectiveMode === 'plan' ? 'default' : 'plan';
      const available = await remote.listModes();
      if (!available.data.some((entry) => entry.mode === mode)) throw new Error('当前 Codex 没有提供该协作模式。');
      if (!effectiveModel) throw new Error('请先选择可用模型。');
      if (activeThread) await remote.setThreadSettings(activeThread.id, {
        collaborationMode: collaborationMode(mode, effectiveModel, activeEffort)
      });
      else setNewTaskMode(mode);
    } else if (command === 'compact') {
      await remote.compactThread(activeThread!.id);
      setCommandNotice('已请求压缩上下文');
    } else if (command === 'review') setCommandDialog({ type: 'review', instructions: argument });
    else if (command === 'fork') await remote.forkThread(activeThread!.id);
    else if (command === 'rename') {
      if (argument) await remote.renameThread(activeThread!.id, argument);
      else { setTaskMenuOpen(true); setRenameDraft(displayThreadTitle(activeThread!)); }
    } else if (command === 'diff') { setInspectorView('changes'); setInspectorOpen(true); }
    else if (command === 'status' || command === 'mcp') setCommandDialog({ type: command });
  }

  async function submitHome(text: string, attachments: ComposerAttachment[], skills: SkillInfo[]) {
    const project = remote.projects.find((entry) => entry.id === selectedProjectId);
    const thread = await remote.createThread({
      ...(project?.roots?.[0]?.path ? { cwd: project.roots[0].path } : {}),
      ...(project?.id ? { projectId: project.id } : {}),
      ...(newTaskModel ? { model: newTaskModel } : {}),
      ...(newTaskEffort ? { effort: newTaskEffort } : {}),
      ...(newTaskMode === 'plan' ? { collaborationMode: collaborationMode('plan', effectiveModel, activeEffort) } : {}),
      ...(effectivePermissions ? { permissions: effectivePermissions } : {})
    });
    await remote.sendTurn(thread.id, text, {
      ...(newTaskModel ? { model: newTaskModel } : {}),
      ...(newTaskEffort ? { effort: newTaskEffort } : {}),
      ...(newTaskMode === 'plan' ? { collaborationMode: collaborationMode('plan', effectiveModel, activeEffort) } : {})
    }, attachments, skills);
  }

  async function submitThread(text: string, attachments: ComposerAttachment[], skills: SkillInfo[]) {
    if (!activeThread) return;
    if (remote.activeTurnId) {
      await remote.steerTurn(activeThread.id, remote.activeTurnId, text, attachments, skills);
      return;
    }
    await remote.sendTurn(activeThread.id, text, {
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(activeEffort ? { effort: activeEffort } : {}),
      ...(activeThread.collaborationMode ? { collaborationMode: collaborationMode(effectiveMode, effectiveModel, activeEffort) } : {})
    }, attachments, skills);
  }

  function openSideChat(input: ChatInput) {
    setSideChatRequest({ id: Date.now(), input });
    setInspectorOpen(true);
  }

  async function logout() {
    try {
      await unlinkDeviceNotifications();
      await api('/api/auth/logout', { method: 'POST', timeoutMs: 8000 });
      onAuthExpired();
    } catch (error) {
      showError(error);
    }
  }

  const title = activeThread ? displayThreadTitle(activeThread) : '新任务';

  return (
    <SubagentsContext.Provider value={subagentsContext}>
    <PreviewLinks cwd={permissionCwd ?? ''} onOpen={openPreview}>
    <WorkspacePanels layout={layout} sidebarCollapsed={sidebarCollapsed} sidebarOpen={sidebarOpen}
      onSidebarOpenChange={setSidebarOpen} inspectorOpen={inspectorOpen}>
      <Sidebar
        remote={remote}
        activeThreadId={remote.activeThreadId}
        layout={layout}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        search={search}
        onSearchChange={setSearch}
        onClose={() => setSidebarOpen(false)}
        onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
        onNewTask={beginNewTask}
        onSelectThread={(threadId) => void selectThread(threadId)}
        onLogout={() => void logout()}
      />

      {layout === 'mobile' && sidebarOpen && (
        <button type="button" className="mobile-backdrop" aria-label="关闭侧边栏" onClick={() => setSidebarOpen(false)} />
      )}

      <main ref={mainRef} className="workspace-main" id="main-content">
        <header className={`workspace-header${activeThread ? '' : ' workspace-header--home'}`}>
          <div className="workspace-header-start">
            {layout === 'mobile' && (
              <button
                type="button"
                className="icon-button"
                onClick={() => setSidebarOpen((value) => !value)}
                aria-label="打开任务列表"
              >
                <Menu size={18} />
              </button>
            )}
            {activeThread && (
              <button
                type="button"
                className="workspace-title"
                onClick={() => { setTaskMenuOpen((value) => !value); setRenameDraft(null); }}
                aria-label={`任务操作：${title}`}
                title={activeThread.cwd}
              >
                <strong>{title}</strong>
                <span className="workspace-path">{activeThread.cwd}</span>
              </button>
            )}
            {!activeThread && <div className="workspace-title"><strong>{title}</strong>
              <span className="workspace-path">{permissionCwd}</span></div>}
          </div>
          <div className="workspace-header-actions">
            {activeThread && (
              <div className="task-menu-anchor">
                <button type="button" className="icon-button" aria-label="任务操作" title="任务操作"
                  aria-expanded={taskMenuOpen} onClick={() => { setTaskMenuOpen((value) => !value); setRenameDraft(null); }}>
                  <MoreHorizontal size={19} />
                </button>
                {taskMenuOpen && (
                  <>
                    <button type="button" className="task-menu-dismiss" aria-label="关闭任务菜单" onClick={() => setTaskMenuOpen(false)} />
                    <div className="task-menu">
                      {renameDraft !== null ? (
                        <form onSubmit={(event) => {
                          event.preventDefault();
                          const name = renameDraft.trim();
                          if (!name) return;
                          void remote.renameThread(activeThread.id, name).then(() => { setTaskMenuOpen(false); setRenameDraft(null); }).catch(showError);
                        }}>
                          <input aria-label="任务名称" value={renameDraft} autoFocus onChange={(event) => setRenameDraft(event.target.value)} />
                          <button type="submit" className="icon-button" aria-label="保存任务名称"><Check size={16} /></button>
                        </form>
                      ) : (
                        <button type="button" onClick={() => setRenameDraft(displayThreadTitle(activeThread))}><Pencil size={15} />重命名</button>
                      )}
                      <button type="button" onClick={() => {
                        setTaskMenuOpen(false);
                        void remote.archiveThread(activeThread.id, !remote.showArchived).catch(showError);
                      }}>
                        {remote.showArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                        {remote.showArchived ? '取消归档' : '归档任务'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {layout === 'desktop' && <button type="button" className="icon-button" aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              title="切换侧边栏" aria-pressed={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((value) => !value)}><PanelLeft size={16} /></button>}
            <button type="button" className="icon-button" aria-label="终端" title="终端"
              aria-pressed={terminalOpen} onClick={() => setTerminalOpen((value) => !value)}><PanelBottom size={16} /></button>
            <button type="button" className="icon-button" aria-label="任务信息" title="任务信息"
              aria-pressed={inspectorOpen && inspectorView === 'files'} onClick={() => {
                setInspectorView('files'); setInspectorOpen((value) => inspectorView === 'files' ? !value : true);
              }}><Info size={16} /></button>
            {activeThread && <button type="button" className="icon-button" aria-label="切换摘要面板固定状态"
              title="切换摘要面板固定状态" aria-pressed={summaryOpen} aria-haspopup={!summaryInline ? 'dialog' : undefined}
              onClick={event => {
                event.currentTarget.focus({ preventScroll: true });
                setInspectorOpen(false);
                if (summaryInline) {
                  const next = !summaryPinned;
                  setSummaryPinned(next);
                  try { localStorage.setItem('summary-panel-pinned', String(next)); } catch { /* Optional preference. */ }
                } else setSummaryOverlayOpen(value => !value);
              }}><SlidersHorizontal size={16} /></button>}
            <button
              type="button"
              className={`icon-button${inspectorOpen ? ' is-active' : ''}`}
              onClick={() => {
                const next = toggleInspectorLauncher(inspectorOpen, inspectorView);
                setInspectorView(next.view);
                setInspectorOpen(next.open);
              }}
              aria-label="打开任务检查器"
              title="打开任务检查器"
              aria-pressed={inspectorOpen}
            >
              <PanelRight size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {startupError && (
          <div className="error-banner" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{startupError}</span>
            <button type="button" onClick={onStartupRetry} aria-label="重新连接">
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {remote.lastError && (
          <div className="error-banner" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{remote.lastError}</span>
            <button type="button" onClick={remote.reconnect} aria-label="重新连接">
              <RefreshCw size={15} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => remote.setLastError(null)} aria-label="关闭错误提示">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {commandNotice && <div className="command-notice" role="status">{commandNotice}</div>}

        {activeThread ? (
          <ThreadScreen
            key={activeThread.id}
            remote={remote}
            thread={activeThread}
            layout={layout}
            model={effectiveModel}
            effort={activeEffort}
            permissions={effectivePermissions}
            onPermissionsChange={changePermissions}
            onModelChange={changeModel}
            onEffortChange={changeEffort}
            onSubmit={submitThread}
            onError={showError}
            commandProps={commandProps}
            onOpenSideChat={openSideChat}
            insertRequest={draftRequest?.threadId === activeThread.id ? draftRequest : null}
          />
        ) : (
          <HomeView
            remote={remote}
            layout={layout}
            selectedProjectId={selectedProjectId}
            model={newTaskModel}
            effort={newTaskEffort}
            permissions={effectivePermissions}
            onPermissionsChange={changePermissions}
            focusRequest={composerFocusRequest}
            onProjectChange={(projectId) => {
              setSelectedProjectId(projectId);
              setNewTaskPermissions('');
              setComposerFocusRequest((value) => value + 1);
            }}
            onModelChange={changeModel}
            onEffortChange={changeEffort}
            onSubmit={submitHome}
            onError={showError}
            commandProps={commandProps}
          />
        )}
        {terminalOpen && <Suspense fallback={<div className="terminal-loading" role="status">加载终端…</div>}>
          <TerminalPanel cwd={permissionCwd} onClose={() => setTerminalOpen(false)} />
        </Suspense>}
        <SummaryPanel key={`summary:${activeThread?.id ?? 'empty'}`} remote={remote} open={summaryOpen} pinned={summaryPinned}
          inline={summaryInline} onClose={closeSummary}
          sideChats={sideChats.chats.filter(chat => chat.sourceThreadId === activeThread?.id)}
          onSideChat={chatId => {
            setSideChatRequest(previous => ({ id: (previous?.id ?? 0) + 1, ...(chatId ? { chatId } : {}) }));
            setSummaryOverlayOpen(false); setInspectorOpen(true);
          }}
          onDraft={insertSummaryDraft} onServers={() => { setSummaryOverlayOpen(false); setCommandDialog({ type: 'mcp' }); }} />
      </main>

      <Inspector
        open={inspectorOpen}
        view={inspectorView}
        layout={layout}
        thread={activeThread}
        items={remote.items}
        onClose={() => setInspectorOpen(false)}
        remote={remote}
        cwd={permissionCwd}
        sideChatRequest={sideChatRequest}
        previewRequest={previewRequest}
        subagentChats={subagentChats}
        subagentRequest={selectedSubagent}
        sideChats={sideChats}
      />
      {commandDialog && <CommandDialog key={`${activeThread?.id ?? 'home'}:${commandDialog.type}`}
        state={commandDialog}
        status={[
          { label: '连接', value: remote.connected ? remote.bridgeStatus.status : 'disconnected' },
          { label: '聊天', value: activeThread ? displayThreadTitle(activeThread) : '新聊天' },
          { label: '模型', value: modelDisplayName(remote.models, effectiveModel) },
          { label: '推理强度', value: reasoningLabel(activeModelInfo, activeEffort) },
          { label: '模式', value: effectiveMode === 'plan' ? '计划' : '默认' },
          { label: '权限', value: permissionLabel(effectivePermissions) },
          { label: '工作目录', value: permissionCwd ?? '' },
          { label: '上下文', value: remote.contextUsage
            ? `${remote.contextUsage.last.totalTokens.toLocaleString()} / ${remote.contextUsage.modelContextWindow?.toLocaleString() ?? '—'} tokens` : '暂无用量' }
        ]}
        loadMcp={() => remote.listMcp(activeThread?.id)}
        onReview={async (target) => {
          if (!hasSavedThread || !activeThread) throw new Error('请先打开一个已保存的聊天。');
          if (remote.activeTurnId) throw new Error('请等待当前任务结束。');
          await remote.reviewThread(activeThread.id, target);
        }}
        onClose={() => { setCommandDialog(null); setComposerFocusRequest((value) => value + 1); }}
      />}
    </WorkspacePanels>
    </PreviewLinks>
    </SubagentsContext.Provider>
  );
}

function HomeView({
  remote,
  layout,
  selectedProjectId,
  model,
  effort,
  permissions,
  onPermissionsChange,
  focusRequest,
  onProjectChange,
  onModelChange,
  onEffortChange,
  onSubmit,
  onError,
  commandProps
}: {
  remote: ReturnType<typeof useRemote>;
  layout: LayoutMode;
  selectedProjectId: string;
  model: string;
  effort: string;
  permissions: string;
  onPermissionsChange: (permissions: string) => Promise<void>;
  focusRequest: number;
  onProjectChange: (projectId: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onSubmit: (text: string, attachments: ComposerAttachment[], skills: SkillInfo[]) => Promise<void>;
  onError: (error: unknown) => void;
  commandProps: Pick<Parameters<typeof Composer>[0], 'onCommand' | 'loadSkills' | 'skillScope' | 'hasSavedThread' | 'mode'>;
}) {
  return (
    <div className={`home-view home-view--${layout}`}>
      <div className="home-hero">
        <div className="home-symbol" aria-hidden="true">
          <img src="/codex-mark.svg" width={48} height={48} alt="" />
        </div>
        <h1>{selectedProjectId ? `在 ${remote.projects.find((project) => project.id === selectedProjectId)?.name ?? '项目'} 中需要什么帮助？` : '有什么可以帮忙？'}</h1>
      </div>
      <div className="home-composer-dock">
        <Composer
          {...commandProps}
          variant="home"
          disabled={!remote.connected}
          layout={layout}
          model={model}
          effort={effort}
          permissions={permissions}
          permissionProfiles={remote.permissionProfiles}
          onPermissionsChange={onPermissionsChange}
          models={remote.models}
          projects={remote.projects}
          selectedProjectId={selectedProjectId}
          focusRequest={focusRequest}
          onProjectChange={onProjectChange}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onSubmit={onSubmit}
          onError={onError}
        />
      </div>
    </div>
  );
}

function ThreadScreen({
  remote,
  thread,
  layout,
  model,
  effort,
  permissions,
  onPermissionsChange,
  onModelChange,
  onEffortChange,
  onSubmit,
  onError,
  commandProps,
  onOpenSideChat,
  insertRequest
}: {
  remote: ReturnType<typeof useRemote>;
  thread: Thread;
  layout: LayoutMode;
  model: string;
  effort: string;
  permissions: string;
  onPermissionsChange: (permissions: string) => Promise<void>;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onSubmit: (text: string, attachments: ComposerAttachment[], skills: SkillInfo[]) => Promise<void>;
  onError: (error: unknown) => void;
  commandProps: Pick<Parameters<typeof Composer>[0], 'onCommand' | 'loadSkills' | 'skillScope' | 'hasSavedThread' | 'mode'>;
  onOpenSideChat: (input: ChatInput) => void;
  insertRequest: { id: number; text: string } | null;
}) {
  const [queueEnabled, setQueueEnabled] = useState(true);
  const [editing, setEditing] = useState<UserMessage | null>(null);
  const editDisabled = !remote.connected || !remote.threadReady || remote.showArchived || Boolean(remote.activeTurnId);
  const editable = !editDisabled && !remote.viewingHistory
    ? editableInterruptedMessage(remote.items, remote.turnTimings, remote.activeTurnId) : null;
  const forkReply = useCallback((turnId: string) => remote.forkThread(thread.id, turnId), [remote.forkThread, thread.id]);
  useEffect(() => { if (!remote.activeTurnId) setQueueEnabled(true); }, [remote.activeTurnId]);
  return (
    <div className="thread-screen">
      <ThreadTimeline
        key={thread.id}
        threadId={thread.id}
        items={remote.items}
        loading={remote.loadingThread}
        activeTurnId={remote.activeTurnId}
        turnTimings={remote.turnTimings}
        hasMoreHistory={remote.hasMoreHistory}
        loadingHistory={remote.loadingHistory}
        onLoadEarlier={remote.loadEarlierHistory}
        onPrefetchEarlier={remote.prefetchEarlierHistory}
        outlineTurns={remote.outlineTurns}
        outlineError={remote.outlineError}
        viewingHistory={remote.viewingHistory}
        hasNewerHistory={remote.hasNewerHistory}
        newerHistoryCursor={remote.newerHistoryCursor}
        loadingLaterHistory={remote.loadingLaterHistory}
        revealingHistory={remote.revealingHistory}
        onLoadLater={remote.loadLaterHistory}
        onRevealHistory={remote.revealHistory}
        onCancelHistoryReveal={remote.cancelHistoryReveal}
        onReturnToLatest={remote.returnToLatest}
        onFork={forkReply}
        onActionError={onError}
        editableMessageId={!remote.messageEditPending ? editable?.id : undefined}
        onEditMessage={setEditing}
      />
      {editing && <EditMessageDialog item={editing} threadId={thread.id} disabled={editDisabled}
        onClose={() => setEditing(null)}
        onSubmit={text => remote.editInterruptedMessage(thread.id, editing, text, {
          model, effort, permissions
        })} />}

      <div className="thread-bottom">
        <GoalStatus key={thread.id} goal={remote.activeGoal} disabled={!remote.connected || !remote.threadReady || remote.showArchived || remote.messageEditPending}
          onUpdate={update => remote.setGoal(thread.id, update)} onDelete={() => remote.clearGoal(thread.id)} onError={onError} />
        {!remote.viewingHistory && <QuestionDock items={remote.items}
          disabled={!remote.connected || !remote.threadReady || remote.showArchived || remote.messageEditPending}
          onSubmit={text => onSubmit(text, [], [])} onError={onError} />}
        <ApprovalDock
          requests={remote.serverRequests.filter((request) => request.params.threadId === thread.id)}
          onRespond={remote.respondToRequest}
          onError={onError}
        />
        {!remote.isNewThread && <QueuedMessages transport={remote.chatTransport} threadId={thread.id}
          readable={remote.authenticated && !remote.showArchived}
          activeTurnId={remote.activeTurnId} connected={remote.connected && remote.threadReady && !remote.messageEditPending}
          onError={onError} onOpenSideChat={onOpenSideChat}
          queueEnabled={queueEnabled} onQueueEnabledChange={setQueueEnabled} />}
        <Composer
          {...commandProps}
          variant="thread"
          draftKey={thread.id}
          insertRequest={insertRequest}
          disabled={!remote.connected || !remote.threadReady || remote.showArchived || remote.messageEditPending}
          layout={layout}
          model={model}
          effort={effort}
          permissions={permissions}
          permissionProfiles={remote.permissionProfiles}
          onPermissionsChange={onPermissionsChange}
          models={remote.models}
          activeTurnId={remote.activeTurnId}
          queueMessages={queueEnabled}
          {...(remote.contextUsage ? { contextUsage: remote.contextUsage } : {})}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onSubmit={async (text, attachments, skills) => {
            if (remote.activeTurnId && queueEnabled) {
              await remote.chatTransport.rpc('thread/queue/add', {
                threadId: thread.id, clientUserMessageId: randomUUID(), input: turnInput(text, attachments, skills)
              });
            } else await onSubmit(text, attachments, skills);
          }}
          {...(remote.activeTurnId
            ? { onStop: () => remote.interruptTurn(thread.id, remote.activeTurnId!) }
            : {})}
          onError={onError}
        />
      </div>
    </div>
  );
}

function useResponsiveLayout(): LayoutMode {
  const getLayout = (): LayoutMode => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    return layoutForViewport(width, height, matchMedia('(pointer: coarse)').matches);
  };
  const [layout, setLayout] = useState<LayoutMode>(getLayout);

  useEffect(() => {
    const update = () => setLayout(getLayout());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return layout;
}
