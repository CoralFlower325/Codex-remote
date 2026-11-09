import {
  CalendarClock, LoaderCircle, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  automationScheduleRule, automationScheduleSummary, automationSchedulePreset, AUTOMATION_WEEKDAYS,
  type Automation, type AutomationList, type AutomationSchedule, type AutomationRun
} from '../../shared/automation-schedule';
import { formatTurnClockTime } from '../../shared/turn-timing';
import { api } from '../api';
import type { ModelInfo, ProjectInfo } from '../types';
import { findModelInfo } from '../workspace-model';
import './automations.css';

type ScheduleKind = AutomationSchedule['kind'];

interface Draft {
  name: string;
  prompt: string;
  projectId: string;
  projectChanged: boolean;
  executionEnvironment: 'local' | 'worktree';
  model: string;
  effort: string;
  kind: ScheduleKind;
  everyMinutes: number;
  minute: number;
  time: string;
  weekday: number;
  active: boolean;
  rrule: string;
  scheduleChanged: boolean;
}

const EFFORT_LABELS: Record<string, string> = {
  none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高'
};

function draftFrom(automation?: Automation): Draft {
  const schedule = automation ? automationSchedulePreset(automation.rrule) : { kind: 'daily' as const, time: '09:00' };
  return {
    name: automation?.name ?? '',
    prompt: automation?.prompt ?? '',
    projectId: automation?.target?.type === 'project' ? automation.target.projectId : '',
    projectChanged: false,
    executionEnvironment: automation?.executionEnvironment ?? 'local',
    model: automation?.model ?? '',
    effort: automation?.reasoningEffort ?? '',
    kind: schedule.kind,
    everyMinutes: schedule.kind === 'interval' ? schedule.everyMinutes : 60,
    minute: schedule.kind === 'hourly' ? schedule.minute : 0,
    time: 'time' in schedule ? schedule.time : '09:00',
    weekday: schedule.kind === 'weekly' ? schedule.weekday : 1,
    active: automation ? automation.status === 'ACTIVE' : true,
    rrule: automation?.rrule ?? '',
    scheduleChanged: !automation
  };
}

function scheduleFrom(draft: Draft): AutomationSchedule {
  switch (draft.kind) {
    case 'interval': return { kind: 'interval', everyMinutes: Math.max(1, Math.floor(draft.everyMinutes) || 1) };
    case 'hourly': return { kind: 'hourly', minute: Math.min(59, Math.max(0, Math.floor(draft.minute) || 0)) };
    case 'daily': return { kind: 'daily', time: draft.time };
    case 'weekdays': return { kind: 'weekdays', time: draft.time };
    case 'weekly': return { kind: 'weekly', weekday: draft.weekday, time: draft.time };
    case 'custom': return { kind: 'custom', rrule: draft.rrule };
  }
}

function runStatusText(automation: Automation, last?: AutomationRun, timeZone?: string): string {
  if (!automation.lastRunAt) return '尚未运行';
  const at = formatTurnClockTime(automation.lastRunAt, Date.now(), timeZone);
  const status = last && ({ IN_PROGRESS: '运行中', PENDING_REVIEW: '待查看',
    ACCEPTED: '已完成', ARCHIVED: '已归档' } as Record<string, string>)[last.status];
  return `上次运行 ${at}${status ? ` · ${status}` : ''}`;
}

export function Automations({ models, projects, onClose, onOpenThread }: {
  models: ModelInfo[];
  projects: ProjectInfo[];
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom());
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [timeZone, setTimeZone] = useState<string>();
  const [checking, setChecking] = useState(false);
  const mounted = useRef(false);
  const busy = useRef(false);
  const read = useRef<AbortController | null>(null);
  const version = useRef(0);

  const refresh = useCallback(async (manual = false) => {
    if (busy.current || !mounted.current) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const current = ++version.current;
    setChecking(true);
    try {
      const result = await api<AutomationList>('/api/automations', {
        cache: 'no-store', signal: controller.signal, timeoutMs: 15000
      });
      if (!mounted.current || current !== version.current) return;
      setAutomations(result.automations); setRuns(result.runs); setTimeZone(result.timeZone);
      if (manual) setError(null);
    } catch (error) {
      if (mounted.current && current === version.current && !controller.signal.aborted) {
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally { if (mounted.current && current === version.current) setChecking(false); }
  }, []);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    return () => { mounted.current = false; version.current++; read.current?.abort(); clearInterval(timer); };
  }, [refresh]);

  const act = async (id: string, action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true; version.current++; read.current?.abort(); setChecking(false);
    setBusyId(id);
    setError(null);
    try { await action(); busy.current = false; await refresh(); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { busy.current = false; if (mounted.current) setBusyId(null); }
  };

  const save = async () => {
    if (busy.current) return;
    const payload = {
      name: draft.name, prompt: draft.prompt,
      ...(editing === 'new' || draft.projectChanged ? { projectId: draft.projectId || null } : {}),
      executionEnvironment: draft.executionEnvironment,
      model: draft.model || null, reasoningEffort: draft.effort || null,
      rrule: draft.scheduleChanged ? automationScheduleRule(scheduleFrom(draft)) : draft.rrule,
      status: draft.active ? 'ACTIVE' : 'PAUSED',
      ...(editing && editing !== 'new' ? { updatedAt: editing.updatedAt } : {})
    };
    busy.current = true; version.current++; read.current?.abort(); setChecking(false); setError(null);
    setSaving(true);
    try {
      if (editing === 'new') await api('/api/automations', { method: 'POST', body: JSON.stringify(payload) });
      else if (editing) await api(`/api/automations/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setEditing(null);
      busy.current = false;
      await refresh();
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  };

  const selectedModel = findModelInfo(models, draft.model);
  const efforts = selectedModel?.supportedReasoningEfforts?.map(entry => entry.reasoningEffort)
    ?? ['low', 'medium', 'high', 'xhigh'];
  const projectName = (automation: Automation) => automation.kind === 'heartbeat' ? '继续现有聊天'
    : automation.target?.type === 'project'
      ? projects.find(entry => entry.id === (automation.target as { projectId: string }).projectId)?.name ?? '原生项目'
      : automation.cwds?.length && automation.target == null ? automation.cwds.join(' · ') : '无项目';
  const mutation = (automation: Automation) => JSON.stringify({ updatedAt: automation.updatedAt });

  return (
    <dialog ref={dialog} className="automations-dialog" aria-label="自动任务"
      onClose={onClose} onCancel={event => { if (busy.current) event.preventDefault(); }}>
      <header className="automations-header">
        <strong><CalendarClock size={17} />自动任务</strong>
        <button type="button" className="icon-button" aria-label="刷新自动任务" title="刷新"
          disabled={Boolean(busyId) || saving || checking} onClick={() => void refresh(true)}>
          <RefreshCw size={16} className={checking ? 'spin' : ''} /></button>
        <button type="button" className="icon-button" aria-label="关闭自动任务"
          disabled={Boolean(busyId) || saving}
          onClick={() => dialog.current?.close()}><X size={18} /></button>
      </header>
      {error && <div className="automations-error" role="alert">{error}</div>}
      <div className="automations-native">Codex Desktop · {timeZone ?? '主机时区'}</div>
      {editing === null ? (
        <div className="automations-body">
          <button type="button" className="automations-new" disabled={automations === null || Boolean(busyId)} onClick={() => {
            setDraft(draftFrom()); setEditing('new'); setError(null);
          }}><Plus size={16} /><span>新建自动任务</span></button>
          {automations === null && <div className="automations-empty">{checking || !error ? '正在加载…' : '无法加载原生任务，请刷新重试。'}</div>}
          {automations?.length === 0 && (
            <div className="automations-empty">还没有自动任务。</div>
          )}
          {automations?.map(automation => {
            const last = runs.filter(run => run.automationId === automation.id)
              .sort((a, b) => b.createdAt - a.createdAt)[0];
            const threadId = last?.threadId ?? automation.targetThreadId;
            return (
            <article className="automation-row" key={automation.id}>
              <div className="automation-main">
                <div className="automation-title">
                  <strong>{automation.name}</strong>
                  <span className={`automation-status automation-status--${automation.status}`}>
                    {automation.status === 'ACTIVE' ? '已启用' : '已暂停'}
                  </span>
                </div>
                <div className="automation-meta">
                  <span title={automation.rrule}>{automationScheduleSummary(automation.rrule)}</span> · {projectName(automation)}
                  {automation.model ? ` · ${findModelInfo(models, automation.model)?.displayName ?? automation.model}` : ''}
                </div>
                <div className="automation-meta">
                  {automation.status === 'ACTIVE' && automation.nextRunAt
                    ? `下次运行 ${formatTurnClockTime(automation.nextRunAt, Date.now(), timeZone)} · ` : ''}
                  {runStatusText(automation, last, timeZone)}
                </div>
                <p className="automation-prompt">{automation.prompt}</p>
                {threadId && (
                  <button type="button" className="automation-link" onClick={() => {
                    dialog.current?.close(); onOpenThread(threadId);
                  }}>查看最近会话</button>
                )}
              </div>
              <div className="automation-actions">
                <button type="button" className="icon-button" aria-label="立即运行"
                  disabled={Boolean(busyId) || automation.kind === 'heartbeat'}
                  title={automation.kind === 'heartbeat' ? '请在 Desktop 确认聊天权限后运行' : '立即运行'}
                  onClick={() => void act(automation.id, () => api(`/api/automations/${encodeURIComponent(automation.id)}/run`, { method: 'POST', body: mutation(automation) }))}>
                  {busyId === automation.id ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                </button>
                <button type="button" className="icon-button"
                  aria-label={automation.status === 'ACTIVE' ? '暂停' : '恢复'}
                  title={automation.status === 'ACTIVE' ? '暂停' : '恢复'}
                  disabled={Boolean(busyId)}
                  onClick={() => void act(automation.id, () => api(`/api/automations/${encodeURIComponent(automation.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: automation.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE', updatedAt: automation.updatedAt })
                  }))}>
                  {automation.status === 'ACTIVE' ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <button type="button" className="icon-button" aria-label="编辑" title="编辑"
                  disabled={Boolean(busyId)}
                  onClick={() => { setDraft(draftFrom(automation)); setEditing(automation); setError(null); }}>
                  <Pencil size={15} />
                </button>
                {confirmDeleteId === automation.id ? (
                  <button type="button" className="automation-confirm-delete"
                    disabled={Boolean(busyId)}
                    onClick={() => void act(automation.id, async () => {
                      await api(`/api/automations/${encodeURIComponent(automation.id)}`, { method: 'DELETE', body: mutation(automation) });
                      setConfirmDeleteId(null);
                    })}>确认删除</button>
                ) : (
                  <button type="button" className="icon-button" aria-label="删除" title="删除"
                    disabled={Boolean(busyId)}
                    onClick={() => setConfirmDeleteId(automation.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </article>
          ); })}
        </div>
      ) : (
        <form className="automations-body automations-editor" inert={saving} onSubmit={event => {
          event.preventDefault(); void save();
        }}>
          <label className="automations-field"><span>名称</span>
            <input value={draft.name} maxLength={80} required placeholder="例如：晨间巡检"
              onChange={event => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="automations-field"><span>提示词</span>
            <textarea value={draft.prompt} maxLength={8000} required rows={5}
              placeholder="每次运行时使用的提示词"
              onChange={event => setDraft({ ...draft, prompt: event.target.value })} />
          </label>
          {editing !== 'new' && editing.kind === 'heartbeat' ? <div className="automations-summary">继续原生聊天</div> : <>
          <label className="automations-field"><span>项目</span>
            <select value={draft.projectId}
              onChange={event => setDraft({ ...draft, projectId: event.target.value, projectChanged: true })}>
              <option value="">任务（无项目）</option>
              {draft.projectId && !projects.some(p => p.id === draft.projectId) &&
                <option value={draft.projectId}>当前原生项目</option>}
              {projects.map(project => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="automations-field"><span>执行环境</span>
            <select value={draft.executionEnvironment} onChange={event =>
              setDraft({ ...draft, executionEnvironment: event.target.value as 'local' | 'worktree' })}>
              <option value="local">本地</option>
              <option value="worktree">工作树</option>
            </select>
          </label></>}
          <div className="automations-grid">
            <label className="automations-field"><span>模型</span>
              <select value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value, effort: '' })}>
                <option value="">默认模型</option>
                {draft.model && !models.some(model => model.model === draft.model && !model.hidden) &&
                  <option value={draft.model}>{draft.model}</option>}
                {models.filter(model => !model.hidden).map(model => (
                  <option key={model.id} value={model.model}>{model.displayName}</option>
                ))}
              </select>
            </label>
            <label className="automations-field"><span>推理强度</span>
              <select value={draft.effort} onChange={event => setDraft({ ...draft, effort: event.target.value })}>
                <option value="">默认</option>
                {draft.effort && !efforts.includes(draft.effort) &&
                  <option value={draft.effort}>{EFFORT_LABELS[draft.effort] ?? draft.effort}</option>}
                {efforts.map(effort => (
                  <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="automations-grid">
            <label className="automations-field"><span>计划</span>
              <select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ScheduleKind, scheduleChanged: true })}>
                <option value="hourly">每小时</option>
                <option value="daily">每天</option>
                <option value="weekdays">工作日</option>
                <option value="weekly">每周</option>
                <option value="interval">自定义间隔</option>
                <option value="custom">原生计划</option>
              </select>
            </label>
            {draft.kind === 'interval' && (
              <label className="automations-field"><span>间隔（分钟）</span>
                <input type="number" min={1} max={10080} value={draft.everyMinutes}
                  onChange={event => setDraft({ ...draft, everyMinutes: Number(event.target.value), scheduleChanged: true })} />
              </label>
            )}
            {draft.kind === 'hourly' && (
              <label className="automations-field"><span>分钟</span>
                <input type="number" min={0} max={59} value={draft.minute}
                  onChange={event => setDraft({ ...draft, minute: Number(event.target.value), scheduleChanged: true })} />
              </label>
            )}
            {(draft.kind === 'daily' || draft.kind === 'weekdays') && (
              <label className="automations-field"><span>时间</span>
                <input type="time" value={draft.time} required
                  onChange={event => setDraft({ ...draft, time: event.target.value, scheduleChanged: true })} />
              </label>
            )}
            {draft.kind === 'weekly' && (<>
              <label className="automations-field"><span>星期</span>
                <select value={draft.weekday}
                  onChange={event => setDraft({ ...draft, weekday: Number(event.target.value), scheduleChanged: true })}>
                  {AUTOMATION_WEEKDAYS.map((label, index) => (
                    <option key={label} value={index}>周{label}</option>
                  ))}
                </select>
              </label>
              <label className="automations-field"><span>时间</span>
                <input type="time" value={draft.time} required
                  onChange={event => setDraft({ ...draft, time: event.target.value, scheduleChanged: true })} />
              </label>
            </>)}
          </div>
          {draft.kind === 'custom' && <label className="automations-field"><span>计划（RRULE）</span>
            <textarea value={draft.rrule} required maxLength={4096} rows={3}
              onChange={event => setDraft({ ...draft, rrule: event.target.value, scheduleChanged: true })} />
          </label>}
          <div className="automations-summary">{automationScheduleSummary(automationScheduleRule(scheduleFrom(draft)))}</div>
          <label className="automations-toggle">
            <input type="checkbox" checked={draft.active}
              onChange={event => setDraft({ ...draft, active: event.target.checked })} />
            <span>启用自动任务</span>
          </label>
          <div className="automations-editor-actions">
            <button type="button" onClick={() => setEditing(null)}>取消</button>
            <button type="submit" className="automations-save" disabled={saving}>
              {saving ? '保存中…' : editing === 'new' ? '创建' : '保存'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
