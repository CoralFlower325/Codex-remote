import * as recurrence from 'rrule';

// Node loads this package's CommonJS entry; Vite selects its ES module entry.
const { RRule, rrulestr } = (Reflect.get(recurrence, 'default') as typeof recurrence | undefined) ?? recurrence;

export interface Automation {
  id: string;
  kind: 'cron' | 'heartbeat';
  name: string;
  prompt: string;
  status: 'ACTIVE' | 'PAUSED';
  rrule: string;
  model: string | null;
  reasoningEffort: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  target?: { type: 'project'; projectId: string } | { type: 'projectless' } | null;
  cwds?: string[];
  targetThreadId?: string;
  executionEnvironment?: 'local' | 'worktree';
  localEnvironmentConfigPath?: string | null;
  autoArchive?: boolean;
  notificationPolicy?: 'failed_runs_only' | null;
}

export interface AutomationRun {
  automationId: string;
  threadId: string;
  status: string;
  createdAt: number;
}

export interface AutomationList {
  automations: Automation[];
  runs: AutomationRun[];
  timeZone: string;
}

export type AutomationMethod = 'list' | 'readHistory' | 'create' | 'update' | 'delete' | 'runNow';
export const automationMethods: readonly AutomationMethod[] =
  ['list', 'readHistory', 'create', 'update', 'delete', 'runNow'];

export type AutomationSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily' | 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'custom'; rrule: string };

export const AUTOMATION_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Editor presets only. Desktop owns validation, timezones and scheduling.
export function automationScheduleRule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'custom') return schedule.rrule;
  if (schedule.kind === 'interval') return `RRULE:FREQ=MINUTELY;INTERVAL=${schedule.everyMinutes}`;
  if (schedule.kind === 'hourly') return `RRULE:FREQ=HOURLY;BYMINUTE=${schedule.minute};BYSECOND=0`;
  const [hour, minute] = schedule.time.split(':').map(Number);
  const days = schedule.kind === 'weekdays' ? ';BYDAY=MO,TU,WE,TH,FR'
    : schedule.kind === 'weekly' ? `;BYDAY=${weekdays[schedule.weekday]}` : '';
  return `RRULE:FREQ=${days ? 'WEEKLY' : 'DAILY'}${days};BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`;
}

export function validAutomationRule(rule: string): boolean {
  if (!rule.trim() || rule.length > 4096) return false;
  try { rrulestr(rule); return true; } catch { return false; }
}

export function automationScheduleSummary(rule: string): string {
  try {
    const parsed = rrulestr(rule);
    if (!(parsed instanceof RRule)) return '自定义计划';
    const { freq, interval } = parsed.options;
    if (freq === RRule.MINUTELY) return `每 ${interval} 分钟`;
    if (freq === RRule.HOURLY) return `每 ${interval} 小时`;
    if (freq === RRule.DAILY) return interval === 1 ? '每天' : `每 ${interval} 天`;
    if (freq === RRule.WEEKLY) return interval === 1 ? '每周' : `每 ${interval} 周`;
    return '自定义计划';
  } catch { return '自定义计划'; }
}
