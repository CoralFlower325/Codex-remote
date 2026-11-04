import { describe, expect, it } from 'vitest';
import { automationScheduleSummary, isAutomationSchedule, nextAutomationRun } from './automation-schedule';

const local = (day: number, hours: number, minutes: number) =>
  new Date(2026, 10, day, hours, minutes, 0, 0).getTime(); // Nov 2026: 5th is a Thursday.

describe('automation schedules', () => {
  it('validates schedule shapes and bounds', () => {
    expect(isAutomationSchedule({ kind: 'daily', time: '09:30' })).toBe(true);
    expect(isAutomationSchedule({ kind: 'daily', time: '24:00' })).toBe(false);
    expect(isAutomationSchedule({ kind: 'hourly', minute: 60 })).toBe(false);
    expect(isAutomationSchedule({ kind: 'interval', everyMinutes: 0 })).toBe(false);
    expect(isAutomationSchedule({ kind: 'weekly', weekday: 7, time: '09:00' })).toBe(false);
    expect(isAutomationSchedule({ kind: 'nope' })).toBe(false);
    expect(isAutomationSchedule(null)).toBe(false);
  });

  it('computes the next interval and hourly runs strictly after now', () => {
    expect(nextAutomationRun({ kind: 'interval', everyMinutes: 30 }, local(5, 9, 0))).toBe(local(5, 9, 30));
    expect(nextAutomationRun({ kind: 'hourly', minute: 15 }, local(5, 9, 10))).toBe(local(5, 9, 15));
    expect(nextAutomationRun({ kind: 'hourly', minute: 15 }, local(5, 9, 15))).toBe(local(5, 10, 15));
    expect(nextAutomationRun({ kind: 'hourly', minute: 15 }, local(5, 9, 45))).toBe(local(5, 10, 15));
  });

  it('rolls daily runs to the next day once the time has passed', () => {
    expect(nextAutomationRun({ kind: 'daily', time: '09:30' }, local(5, 9, 0))).toBe(local(5, 9, 30));
    expect(nextAutomationRun({ kind: 'daily', time: '09:30' }, local(5, 9, 30))).toBe(local(6, 9, 30));
  });

  it('skips weekends for weekday schedules', () => {
    // 2026-11-06 is a Friday, 2026-11-09 is a Monday.
    expect(nextAutomationRun({ kind: 'weekdays', time: '09:00' }, local(6, 10, 0))).toBe(local(9, 9, 0));
    expect(nextAutomationRun({ kind: 'weekdays', time: '09:00' }, local(5, 8, 0))).toBe(local(5, 9, 0));
  });

  it('finds the matching weekday for weekly schedules', () => {
    expect(nextAutomationRun({ kind: 'weekly', weekday: 1, time: '08:00' }, local(5, 9, 0))).toBe(local(9, 8, 0));
    expect(nextAutomationRun({ kind: 'weekly', weekday: 4, time: '08:00' }, local(5, 9, 0))).toBe(local(12, 8, 0));
    expect(nextAutomationRun({ kind: 'weekly', weekday: 4, time: '10:00' }, local(5, 9, 0))).toBe(local(5, 10, 0));
  });

  it('summarizes schedules in Chinese', () => {
    expect(automationScheduleSummary({ kind: 'interval', everyMinutes: 45 })).toBe('每 45 分钟');
    expect(automationScheduleSummary({ kind: 'interval', everyMinutes: 120 })).toBe('每 2 小时');
    expect(automationScheduleSummary({ kind: 'hourly', minute: 5 })).toBe('每小时 :05');
    expect(automationScheduleSummary({ kind: 'daily', time: '09:30' })).toBe('每天 09:30');
    expect(automationScheduleSummary({ kind: 'weekdays', time: '09:30' })).toBe('工作日 09:30');
    expect(automationScheduleSummary({ kind: 'weekly', weekday: 3, time: '21:00' })).toBe('每周三 21:00');
  });
});
