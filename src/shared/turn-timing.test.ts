import { describe, expect, it } from 'vitest';

import { elapsedTurnMs, formatTurnClockTime, formatWorkDuration, turnClockTimes, type TurnTiming } from './turn-timing';

const turn: TurnTiming = { id: 't', status: 'inProgress', startedAt: 100, completedAt: null, durationMs: null };

describe('native turn timing', () => {
  it('converts native Unix seconds to elapsed milliseconds without depending on loaded user messages', () => {
    expect(elapsedTurnMs(turn, 147_000)).toBe(47_000);
    expect(elapsedTurnMs(turn, 148_000)).toBe(48_000);
  });

  it('uses saved native timestamps before the total generation duration, as Desktop does on hydration', () => {
    expect(elapsedTurnMs({ ...turn, status: 'completed', completedAt: 200, durationMs: 99_987 }, 999_000)).toBe(100_000);
    expect(elapsedTurnMs({ ...turn, status: 'interrupted', completedAt: 150 }, 999_000)).toBe(50_000);
    expect(elapsedTurnMs({ ...turn, status: 'completed', durationMs: 99_987 }, 999_000)).toBe(99_987);
    expect(elapsedTurnMs({ ...turn, status: 'completed', startedAt: null, durationMs: 400 }, 999_000)).toBe(400);
  });

  it('freezes work time at the native final-answer start while streaming and after completion', () => {
    expect(elapsedTurnMs(turn, 180_000, 147_250)).toBe(47_250);
    expect(elapsedTurnMs(turn, 999_000, 147_250)).toBe(47_250);
    expect(elapsedTurnMs({ ...turn, status: 'completed', completedAt: 200, durationMs: 100_000 },
      999_000, 147_250)).toBe(47_250);
  });

  it('does not invent a duration for missing timestamps or a failed turn without an end', () => {
    expect(elapsedTurnMs({ ...turn, startedAt: null }, 147_000)).toBeNull();
    expect(elapsedTurnMs({ ...turn, status: 'failed' }, 147_000)).toBeNull();
    expect(elapsedTurnMs(turn, 90_000)).toBe(0);
  });

  it('derives wall-clock start and end from native timestamps only', () => {
    expect(turnClockTimes({ ...turn, status: 'completed', completedAt: 200, durationMs: 99_987 }))
      .toEqual({ startMs: 100_000, endMs: 200_000 });
    expect(turnClockTimes({ ...turn, status: 'interrupted', completedAt: 150 }))
      .toEqual({ startMs: 100_000, endMs: 150_000 });
    expect(turnClockTimes(turn)).toEqual({ startMs: 100_000, endMs: null });
    expect(turnClockTimes({ ...turn, status: 'completed', startedAt: null, completedAt: 200, durationMs: 40_000 }))
      .toEqual({ startMs: 160_000, endMs: 200_000 });
    expect(turnClockTimes({ ...turn, status: 'completed', startedAt: null, durationMs: 400 }))
      .toEqual({ startMs: null, endMs: null });
    expect(turnClockTimes({ ...turn, status: 'failed', completedAt: null }))
      .toEqual({ startMs: 100_000, endMs: null });
  });

  it('formats clock times with same-day times bare and older days dated', () => {
    const start = new Date(2026, 10, 5, 14, 3, 22).getTime();
    const sameDay = new Date(2026, 10, 5, 23, 59, 59).getTime();
    const nextDay = new Date(2026, 10, 6, 0, 0, 1).getTime();
    expect(formatTurnClockTime(start, sameDay)).toBe('14:03:22');
    expect(formatTurnClockTime(start, nextDay)).toBe('11月5日 14:03:22');
    const midnight = new Date(2026, 10, 5, 0, 0, 5).getTime();
    expect(formatTurnClockTime(midnight, sameDay)).toBe('00:00:05');
  });

  it('formats seconds and minute/hour boundaries without rounding to 60 seconds', () => {
    expect(formatWorkDuration(59_999)).toBe('59秒');
    expect(formatWorkDuration(60_000)).toBe('1分钟');
    expect(formatWorkDuration(1_013_000)).toBe('16分钟 53秒');
    expect(formatWorkDuration(3_661_000)).toBe('1小时 1分钟 1秒');
    expect(formatWorkDuration(3_600_000)).toBe('1小时');
    expect(formatWorkDuration(86_400_000)).toBe('1天');
    expect(formatWorkDuration(90_061_000)).toBe('1天 1小时 1分钟 1秒');
    expect(formatWorkDuration(999)).toBe('0秒');
  });
});
