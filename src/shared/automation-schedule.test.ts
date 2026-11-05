import { describe, expect, it } from 'vitest';
import { RRule, rrulestr } from 'rrule';
import { automationScheduleRule, automationScheduleSummary, validAutomationRule } from './automation-schedule';

describe('native automation schedule editor', () => {
  it('emits native RRULE presets without calculating or storing run times', () => {
    const rule = automationScheduleRule({ kind: 'weekdays', time: '09:30' });
    expect(rrulestr(rule).origOptions).toMatchObject({
      freq: RRule.WEEKLY, byhour: 9, byminute: 30
    });
    expect(rule).toContain('BYDAY=MO,TU,WE,TH,FR');
    expect(automationScheduleRule({ kind: 'weekly', weekday: 0, time: '10:00' })).toContain('BYDAY=SU');
    expect(automationScheduleRule({ kind: 'hourly', minute: 15 })).toContain('BYMINUTE=15');
  });

  it('preserves native custom rules and timezone information verbatim', () => {
    const rule = 'DTSTART;TZID=America/New_York:20261105T090000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=3,15';
    expect(automationScheduleRule({ kind: 'custom', rrule: rule })).toBe(rule);
    expect(validAutomationRule(rule)).toBe(true);
    expect(automationScheduleSummary(rule)).toBe('自定义计划');
  });

  it('rejects malformed rules and keeps labels bounded', () => {
    expect(validAutomationRule('')).toBe(false);
    expect(validAutomationRule('nonsense')).toBe(false);
    expect(validAutomationRule('x'.repeat(4097))).toBe(false);
    expect(automationScheduleSummary('bad')).toBe('自定义计划');
    expect(automationScheduleSummary('RRULE:FREQ=HOURLY;INTERVAL=2')).toBe('每 2 小时');
  });
});
