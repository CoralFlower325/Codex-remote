import {
  CalendarClock, LoaderCircle, Pause, Pencil, Play, Plus, Trash2, X
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  automationScheduleSummary, AUTOMATION_WEEKDAYS,
  type Automation, type AutomationSchedule
} from '../../shared/automation-schedule';
import { formatTurnClockTime } from '../../shared/turn-timing';
import { api } from '../api';
import type { RemoteState } from '../useRemote';
import './automations.css';

type ScheduleKind = AutomationSchedule['kind'];

interface Draft {
  name: string;
  prompt: string;
  projectId: string;
  model: string;
  effort: string;
  kind: ScheduleKind;
  everyMinutes: number;
  minute: number;
  time: string;
  weekday: number;
  active: boolean;
}

const EFFORT_LABELS: Record<string, string> = {
  none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高'
};

function draftFrom(automation?: Automation): Draft {
  const schedule = automation?.schedule;
  return {
    name: automation?.name ?? '',
    prompt: automation?.prompt ?? '',
    projectId: automation?.projectId ?? '',
    model: automation?.model ?? '',
    effort: automation?.effort ?? '',
    kind: schedule?.kind ?? 'daily',
    everyMinutes: schedule?.kind === 'interval' ? schedule.everyMinutes : 60,
    minute: schedule?.kind === 'hourly' ? schedule.minute : 0,
    time: schedule && (schedule.kind === 'daily' || schedule.kind === 'weekdays' || schedule.kind === 'weekly')
      ? schedule.time : '09:00',
    weekday: schedule?.kind === 'weekly' ? schedule.weekday : 1,
    active: automation ? automation.status === 'active' : true
  };
}

function scheduleFrom(draft: Draft): AutomationSchedule {
  switch (draft.kind) {
    case 'interval': return { kind: 'interval', everyMinutes: Math.max(1, Math.floor(draft.everyMinutes) || 1) };
    case 'hourly': return { kind: 'hourly', minute: Math.min(59, Math.max(0, Math.floor(draft.minute) || 0)) };
    case 'daily': return { kind: 'daily', time: draft.time };
    case 'weekdays': return { kind: 'weekdays', time: draft.time };
    case 'weekly': return { kind: 'weekly', weekday: draft.weekday, time: draft.time };
  }
}

function runStatusText(automation: Automation): string {
  const last = automation.runs[0];
  if (!last) return '尚未运行';
  const at = formatTurnClockTime(last.at, Date.now());
  if (last.status === 'started') return `上次运行 ${at} · 已开始`;
  if (last.status === 'failed') return `上次运行 ${at} · 主机拒绝${last.error ? `：${last.error}` : ''}`;
  return `上次运行 ${at} · 结果未知${last.error ? `：${last.error}` : ''}`;
}

export function Automations({ remote, onClose, onOpenThread }: {
  remote: RemoteState;
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

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ automations: Automation[] }>('/api/automations', { cache: 'no-store' });
      setAutomations(result.automations);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    try { await action(); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(null); }
  };

  const save = async () => {
    const project = remote.projects.find(entry => entry.id === draft.projectId);
    const payload = {
      name: draft.name, prompt: draft.prompt,
      projectId: project?.id ?? null, cwd: project?.roots[0]?.path ?? null,
      model: draft.model || null, effort: draft.effort || null,
      schedule: scheduleFrom(draft), status: draft.active ? 'active' : 'paused'
    };
    setSaving(true);
    try {
      if (editing === 'new') await api('/api/automations', { method: 'POST', body: JSON.stringify(payload) });
      else if (editing) await api(`/api/automations/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setEditing(null);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };

  const selectedModel = remote.models.find(entry => entry.model === draft.model);
  const efforts = selectedModel?.supportedReasoningEfforts?.map(entry => entry.reasoningEffort)
    ?? ['low', 'medium', 'high', 'xhigh'];
  const projectName = (automation: Automation) =>
    remote.projects.find(entry => entry.id === automation.projectId)?.name
    ?? (automation.cwd ? automation.cwd.split('/').filter(Boolean).at(-1) : null)
    ?? '任务';

  return (
    <dialog ref={dialog} className="automations-dialog" aria-label="自动任务"
      onClose={onClose} onCancel={onClose}>
      <header className="automations-header">
        <strong><CalendarClock size={17} />自动任务</strong>
        <button type="button" className="icon-button" aria-label="关闭自动任务"
          onClick={() => dialog.current?.close()}><X size={18} /></button>
      </header>
      {error && <div className="automations-error" role="alert">{error}</div>}
      {editing === null ? (
        <div className="automations-body">
          <button type="button" className="automations-new" onClick={() => {
            setDraft(draftFrom()); setEditing('new'); setError(null);
          }}><Plus size={16} /><span>新建自动任务</span></button>
          {automations === null && <div className="automations-empty">正在加载…</div>}
          {automations?.length === 0 && (
            <div className="automations-empty">还没有自动任务。新建后，Remote 会按计划在所选项目里开启新会话并发送提示词；桌面端离线时顺延到重新连接后合并执行一次。</div>
          )}
          {automations?.map(automation => (
            <article className="automation-row" key={automation.id}>
              <div className="automation-main">
                <div className="automation-title">
                  <strong>{automation.name}</strong>
                  <span className={`automation-status automation-status--${automation.status}`}>
                    {automation.status === 'active' ? '进行中' : '已暂停'}
                  </span>
                </div>
                <div className="automation-meta">
                  {automationScheduleSummary(automation.schedule)} · {projectName(automation)}
                  {automation.model ? ` · ${remote.models.find(entry => entry.model === automation.model)?.displayName ?? automation.model}` : ''}
                </div>
                <div className="automation-meta">
                  {automation.status === 'active' && automation.nextRunAt
                    ? `下次运行 ${formatTurnClockTime(automation.nextRunAt, Date.now())} · ` : ''}
                  {runStatusText(automation)}
                </div>
                <p className="automation-prompt">{automation.prompt}</p>
                {automation.lastThreadId && (
                  <button type="button" className="automation-link" onClick={() => {
                    dialog.current?.close(); onOpenThread(automation.lastThreadId!);
                  }}>查看最近会话</button>
                )}
              </div>
              <div className="automation-actions">
                <button type="button" className="icon-button" aria-label="立即运行" title="立即运行"
                  disabled={busyId === automation.id}
                  onClick={() => void act(automation.id, () => api(`/api/automations/${automation.id}/run`, { method: 'POST', body: '{}' }))}>
                  {busyId === automation.id ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                </button>
                <button type="button" className="icon-button"
                  aria-label={automation.status === 'active' ? '暂停' : '恢复'}
                  title={automation.status === 'active' ? '暂停' : '恢复'}
                  disabled={busyId === automation.id}
                  onClick={() => void act(automation.id, () => api(`/api/automations/${automation.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: automation.status === 'active' ? 'paused' : 'active' })
                  }))}>
                  {automation.status === 'active' ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <button type="button" className="icon-button" aria-label="编辑" title="编辑"
                  onClick={() => { setDraft(draftFrom(automation)); setEditing(automation); setError(null); }}>
                  <Pencil size={15} />
                </button>
                {confirmDeleteId === automation.id ? (
                  <button type="button" className="automation-confirm-delete"
                    disabled={busyId === automation.id}
                    onClick={() => void act(automation.id, async () => {
                      await api(`/api/automations/${automation.id}`, { method: 'DELETE' });
                      setConfirmDeleteId(null);
                    })}>确认删除</button>
                ) : (
                  <button type="button" className="icon-button" aria-label="删除" title="删除"
                    onClick={() => setConfirmDeleteId(automation.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <form className="automations-body automations-editor" onSubmit={event => {
          event.preventDefault(); void save();
        }}>
          <label className="automations-field"><span>名称</span>
            <input value={draft.name} maxLength={80} required placeholder="例如：晨间巡检"
              onChange={event => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="automations-field"><span>提示词</span>
            <textarea value={draft.prompt} maxLength={8000} required rows={5}
              placeholder="每次运行时发送给新会话的提示词"
              onChange={event => setDraft({ ...draft, prompt: event.target.value })} />
          </label>
          <label className="automations-field"><span>项目</span>
            <select value={draft.projectId}
              onChange={event => setDraft({ ...draft, projectId: event.target.value })}>
              <option value="">任务（无项目）</option>
              {remote.projects.map(project => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <div className="automations-grid">
            <label className="automations-field"><span>模型</span>
              <select value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value, effort: '' })}>
                <option value="">默认模型</option>
                {remote.models.filter(model => !model.hidden).map(model => (
                  <option key={model.id} value={model.model}>{model.displayName}</option>
                ))}
              </select>
            </label>
            <label className="automations-field"><span>推理强度</span>
              <select value={draft.effort} onChange={event => setDraft({ ...draft, effort: event.target.value })}>
                <option value="">默认</option>
                {efforts.map(effort => (
                  <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="automations-grid">
            <label className="automations-field"><span>计划</span>
              <select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ScheduleKind })}>
                <option value="hourly">每小时</option>
                <option value="daily">每天</option>
                <option value="weekdays">工作日</option>
                <option value="weekly">每周</option>
                <option value="interval">自定义间隔</option>
              </select>
            </label>
            {draft.kind === 'interval' && (
              <label className="automations-field"><span>间隔（分钟）</span>
                <input type="number" min={1} max={10080} value={draft.everyMinutes}
                  onChange={event => setDraft({ ...draft, everyMinutes: Number(event.target.value) })} />
              </label>
            )}
            {draft.kind === 'hourly' && (
              <label className="automations-field"><span>分钟</span>
                <input type="number" min={0} max={59} value={draft.minute}
                  onChange={event => setDraft({ ...draft, minute: Number(event.target.value) })} />
              </label>
            )}
            {(draft.kind === 'daily' || draft.kind === 'weekdays') && (
              <label className="automations-field"><span>时间</span>
                <input type="time" value={draft.time} required
                  onChange={event => setDraft({ ...draft, time: event.target.value })} />
              </label>
            )}
            {draft.kind === 'weekly' && (<>
              <label className="automations-field"><span>星期</span>
                <select value={draft.weekday}
                  onChange={event => setDraft({ ...draft, weekday: Number(event.target.value) })}>
                  {AUTOMATION_WEEKDAYS.map((label, index) => (
                    <option key={label} value={index}>周{label}</option>
                  ))}
                </select>
              </label>
              <label className="automations-field"><span>时间</span>
                <input type="time" value={draft.time} required
                  onChange={event => setDraft({ ...draft, time: event.target.value })} />
              </label>
            </>)}
          </div>
          <div className="automations-summary">{automationScheduleSummary(scheduleFrom(draft))}</div>
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
