import { describe, it, expect } from 'vitest';
import { trayAppearance } from './tray-state.mjs';

describe('resident service icon', () => {
  it('uses a dim icon for stopped, unknown and foreign services', () => {
    for (const status of [null, { state: 'stopped', service: { running: false } },
      { state: 'unowned', service: { running: true } }, { state: 'conflict', service: { running: true } }]) {
      expect(trayAppearance(status, '').running).toBe(false);
    }
    expect(trayAppearance({ state: 'healthy', service: { running: true } }, 'probe failed').running).toBe(false);
  });
  it('keeps an owned running service bright despite unavailable Desktop or public access', () => {
    const status = { state: 'degraded', service: { running: true }, desktop: false,
      publicEntry: { reachable: false } };
    expect(trayAppearance(status, '', true)).toEqual({
      running: true, template: 'trayRunningTemplate.png', windows: 'trayRunning.png'
    });
    expect(trayAppearance(status, '', false).windows).toBe('trayRunningTemplate.png');
  });
});
