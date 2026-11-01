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
  it('explains protected-path rejections in Chinese without treating them as network failures', () => {
    const error = new Error('The release contains a protected path.');
    expect(updateError(error)).toContain('\u53d7\u4fdd\u62a4');
    expect(updateError(error)).toContain('\u65b0\u7248\u7ba1\u7406\u5668');
    expect(updateError(error)).not.toContain('protected path');
    expect(networkFailure(error)).toBe(false);
  });
  it('recognizes standard fetch timeouts without retrying operator cancellations', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const wrapped = new Error('release request ended', { cause: timeout });
    for (const error of [timeout, wrapped]) {
      expect(networkFailure(error)).toBe(true);
      expect(updateError(error)).toContain('\u8d85\u65f6');
      expect(updateError(error)).not.toContain('\u5c55\u5f00\u6700\u8fd1\u8f93\u51fa');
    }
    const cancelled = new DOMException('The operation was aborted', 'AbortError');
    expect(networkFailure(cancelled)).toBe(false);
    expect(networkFailure(new DOMException('ETIMEDOUT operator cancelled', 'AbortError'))).toBe(false);
  });
  it.each([
    [429, '\u9650\u6d41', true],
    [500, '\u6682\u4e0d\u53ef\u7528', true],
    [502, '\u6682\u4e0d\u53ef\u7528', true],
    [503, '\u6682\u4e0d\u53ef\u7528', true],
    [403, '\u62d2\u7edd\u8bbf\u95ee', false],
    [404, '\u6587\u4ef6\u6682\u4e0d\u53ef\u7528', false],
    [400, '\u4e0b\u8f7d\u8bf7\u6c42\u5931\u8d25', false]
  ])('explains release HTTP %s with only transient failures eligible for retry', (status, text, retry) => {
    for (const message of [`Release check failed (HTTP ${status}).`,
      `\u8fd0\u884c\u5305\u4e0b\u8f7d\u5931\u8d25\uff08HTTP ${status}\uff09\u3002`]) {
      const error = new Error(message);
      expect(updateError(error)).toContain(text);
      expect(updateError(error)).toContain(String(status));
      expect(updateError(error)).not.toContain('TUN');
      expect(networkFailure(error)).toBe(retry);
    }
  });
  it('does not retry unrelated HTTP failures as release download failures', () => {
    expect(networkFailure(new Error('Local service health failed HTTP 503'))).toBe(false);
    expect(networkFailure(new Error('Native authorization HTTP 429'))).toBe(false);
  });
});
