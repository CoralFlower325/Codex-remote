import { describe, it, expect, vi } from 'vitest';
import { cleanOutput, createUpdateProgress, networkFailure, updateError } from './update-progress.mjs';

describe('update reporting', () => {
  it('advances only when a step completes and keeps bounded output without changing its percentage', () => {
    const notifications = [];
    const progress = createUpdateProgress((title, state) => notifications.push({ title, ...state }));
    progress.start('dependencies');
    expect(notifications.at(-1).percent).toBe(18);
    progress.output('npm http fetch package\n'.repeat(80));
    expect(notifications.at(-1).percent).toBe(18);
    expect(notifications.at(-1).logs).toHaveLength(40);
    progress.finish('dependencies');
    expect(notifications.at(-1).percent).toBe(43);
    progress.start('typecheck');
    expect(notifications.at(-1).percent).toBe(43);
    progress.terminal('failed', '检查未完成', '未改变当前安装');
    expect(notifications.at(-1).percent).toBe(43);
    expect(notifications.at(-1).endedAt).toEqual(expect.any(Number));
    expect(notifications[0].logs).toEqual([]);
  });
  it('reports recovery separately from successful installation and flushes final output', () => {
    const notify = vi.fn();
    const progress = createUpdateProgress(notify);
    progress.start('install');
    progress.output('first');
    progress.output('last');
    progress.recovery('restore', '恢复旧版', 40, '恢复依赖');
    expect(notify.mock.calls.at(-1)[1]).toMatchObject({ percent: 40, status: 'recovering' });
    expect(notify.mock.calls.at(-1)[1].logs.at(-1).message).toBe('last');
    progress.terminal('recovered', '已恢复旧版', '保持原有状态');
    expect(notify.mock.calls.at(-1)[1]).toMatchObject({ percent: 100, status: 'recovered' });
  });
  it('classifies the reported npm reset as transient without retrying validation or permissions', () => {
    expect(networkFailure(new Error('npm error code ECONNRESET socket hang up'))).toBe(true);
    expect(networkFailure(new Error('net::ERR_CONNECTION_RESET'))).toBe(true);
    expect(networkFailure(new Error('terminated', { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
    expect(networkFailure(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe(false);
    for (const message of ['EACCES', 'validation failure', 'test failure', 'ENOSPC']) {
      expect(networkFailure(new Error(message))).toBe(false);
    }
    expect(updateError(new Error('ECONNRESET https://registry.npmjs.org/zwitch'))).toContain('网络');
    expect(updateError(new Error('EACCES'))).toContain('权限');
    expect(updateError(new Error('ENOSPC'))).toContain('空间');
    expect(cleanOutput('\u001b[31mhttps://user:secret@registry.example.com password=secret token=private'))
      .not.toMatch(/secret|private|\u001b/);
  });
});
