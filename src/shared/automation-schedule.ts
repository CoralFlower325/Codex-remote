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

export function automationSchedulePreset(rule: string): AutomationSchedule {
  const custom: AutomationSchedule = { kind: 'custom', rrule: rule };
  try {
    const parsed = rrulestr(rule);
    if (!(parsed instanceof RRule) || /DTSTART|TZID|EXDATE|RDATE/i.test(rule)) return custom;
    const options = parsed.origOptions;
    if (Object.entries(options).some(([key, value]) => value != null &&
      !['freq', 'interval', 'byhour', 'byminute', 'bysecond', 'byweekday'].includes(key))) return custom;
    const one = (value: number | number[] | null | undefined, fallback: number) =>
      value == null ? fallback : Array.isArray(value) ? value.length === 1 ? value[0] ?? NaN : NaN : value;
    const hour = one(options.byhour, 0);
    const minute = one(options.byminute, 0);
    const second = one(options.bysecond, 0);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || second !== 0) return custom;
    if (options.freq === RRule.MINUTELY && options.byhour == null && options.byminute == null &&
      options.bysecond == null && options.byweekday == null) {
      return { kind: 'interval', everyMinutes: options.interval ?? 1 };
    }
    if ((options.interval ?? 1) !== 1) return custom;
    if (options.byminute == null || options.bysecond == null) return custom;
    if (options.freq === RRule.HOURLY && options.byhour == null && options.byweekday == null) {
      return { kind: 'hourly', minute };
    }
    if (options.byhour == null) return custom;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (options.freq === RRule.DAILY && options.byweekday == null) return { kind: 'daily', time };
    if (options.freq !== RRule.WEEKLY) return custom;
    const days = (Array.isArray(options.byweekday) ? options.byweekday : [options.byweekday])
      .map(day => typeof day === 'number' ? day : day && typeof day === 'object' && day.n == null ? day.weekday : NaN);
    if (days.length === 1 && Number.isInteger(days[0])) return { kind: 'weekly', weekday: (days[0]! + 1) % 7, time };
    if ([...new Set(days)].sort().join(',') === '0,1,2,3,4') return { kind: 'weekdays', time };
    return custom;
  } catch { return custom; }
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
