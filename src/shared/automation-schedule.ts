// Scheduling model for Remote automations. Native Codex App Server exposes no
// automation API (verified against the generated protocol schema), so Remote
// stores definitions privately and dispatches them through the existing
// Desktop bridge. Schedule kinds mirror the native automation presets:
// hourly, daily, weekdays, weekly, plus a custom minute interval.

export type AutomationSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string };

export type AutomationStatus = 'active' | 'paused';
export type AutomationRunStatus = 'started' | 'failed' | 'unknown';

export interface AutomationRunRecord {
  at: number;
  kind: 'scheduled' | 'manual';
  status: AutomationRunStatus;
  threadId?: string;
  error?: string;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  projectId: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  runs: AutomationRunRecord[];
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const AUTOMATION_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export function isAutomationSchedule(value: unknown): value is AutomationSchedule {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'interval':
      return Number.isInteger(value.everyMinutes)
        && (value.everyMinutes as number) >= 1 && (value.everyMinutes as number) <= 7 * 24 * 60;
    case 'hourly':
      return Number.isInteger(value.minute) && (value.minute as number) >= 0 && (value.minute as number) <= 59;
    case 'daily':
    case 'weekdays':
      return typeof value.time === 'string' && TIME_PATTERN.test(value.time);
    case 'weekly':
      return Number.isInteger(value.weekday) && (value.weekday as number) >= 0 && (value.weekday as number) <= 6
        && typeof value.time === 'string' && TIME_PATTERN.test(value.time);
    default:
      return false;
  }
}

function atTime(day: Date, time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
  return candidate.getTime();
}

/** First run time strictly after `afterMs`, in the host's local timezone. */
export function nextAutomationRun(schedule: AutomationSchedule, afterMs: number): number {
  switch (schedule.kind) {
    case 'interval':
      return afterMs + schedule.everyMinutes * 60_000;
    case 'hourly': {
      const after = new Date(afterMs);
      let candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), schedule.minute, 0, 0).getTime();
      if (candidate <= afterMs) candidate += 3_600_000;
      return candidate;
    }
    case 'daily': {
      let candidate = atTime(new Date(afterMs), schedule.time);
      if (candidate <= afterMs) {
        const next = new Date(afterMs); next.setDate(next.getDate() + 1);
        candidate = atTime(next, schedule.time);
      }
      return candidate;
    }
    case 'weekdays': {
      for (let offset = 0; offset < 8; offset++) {
        const day = new Date(afterMs); day.setDate(day.getDate() + offset);
        const weekday = day.getDay();
        if (weekday === 0 || weekday === 6) continue;
        const candidate = atTime(day, schedule.time);
        if (candidate > afterMs) return candidate;
      }
      throw new Error('No weekday found');
    }
    case 'weekly': {
      for (let offset = 0; offset < 8; offset++) {
        const day = new Date(afterMs); day.setDate(day.getDate() + offset);
        if (day.getDay() !== schedule.weekday) continue;
        const candidate = atTime(day, schedule.time);
        if (candidate > afterMs) return candidate;
      }
      throw new Error('No matching weekday found');
    }
  }
}

export function automationScheduleSummary(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case 'interval':
      return schedule.everyMinutes % 60 === 0
        ? `每 ${schedule.everyMinutes / 60} 小时` : `每 ${schedule.everyMinutes} 分钟`;
    case 'hourly':
      return `每小时 :${String(schedule.minute).padStart(2, '0')}`;
    case 'daily':
      return `每天 ${schedule.time}`;
    case 'weekdays':
      return `工作日 ${schedule.time}`;
    case 'weekly':
      return `每周${AUTOMATION_WEEKDAYS[schedule.weekday]} ${schedule.time}`;
  }
}
