import { nativeTurnError, type NativeTurnError } from './native-error.js';

export interface TurnTiming {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error?: NativeTurnError | null;
  errorWillRetry?: boolean;
}

export function projectTurnTiming(turn: TurnTiming): TurnTiming {
  const { id, status, startedAt, completedAt, durationMs } = turn;
  return { id, status, startedAt, completedAt, durationMs,
    ...(turn.error ? { error: nativeTurnError(turn.error) } : {}) };
}

export function runtimeTurnError(current: Record<string, TurnTiming>, method: string,
  params: Record<string, unknown>): Record<string, TurnTiming> {
  const id = typeof params.turnId === 'string' ? params.turnId : '';
  if (!id) return current;
  const previous = current[id];
  if (method === 'error') {
    const error = nativeTurnError(params.error);
    if (!error) return current;
    return { ...current, [id]: { ...(previous ?? { id, status: 'inProgress', startedAt: null,
      completedAt: null, durationMs: null }), error, errorWillRetry: params.willRetry === true } };
  }
  if (previous?.error && previous.errorWillRetry && ['item/started', 'item/completed',
    'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/plan/delta',
    'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded'].includes(method)) {
    const { error: _error, errorWillRetry: _retry, ...recovered } = previous;
    return { ...current, [id]: recovered };
  }
  return current;
}

export function elapsedTurnMs(turn: TurnTiming, nowMs: number, finalStartedAtMs?: number | null): number | null {
  if (turn.startedAt == null) return turn.status !== 'inProgress' && turn.durationMs != null
    ? Math.max(0, turn.durationMs) : null;
  // Desktop freezes the work divider when the final answer starts streaming.
  const endMs = finalStartedAtMs ?? (turn.status === 'inProgress' ? nowMs
    : turn.completedAt == null ? null : turn.completedAt * 1000);
  if (endMs == null && turn.durationMs != null) return Math.max(0, turn.durationMs);
  return endMs == null ? null : Math.max(0, endMs - turn.startedAt * 1000);
}

const durationUnits = (['day', 'hour', 'minute', 'second'] as const).map(unit =>
  new Intl.NumberFormat('zh-CN', { style: 'unit', unit, unitDisplay: 'narrow' }));

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const values = [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60, seconds % 60];
  return values.flatMap((value, index) => value > 0 ? [durationUnits[index]!.format(value)] : []).join(' ')
    || durationUnits[3]!.format(0);
}
