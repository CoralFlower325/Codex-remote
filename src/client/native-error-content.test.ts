import { describe, expect, it } from 'vitest';
import { nativeErrorContent } from './native-error-content';

describe('Desktop native error content projection', () => {
  it('uses native retry progress and never invents attempts for a generic error', () => {
    expect(nativeErrorContent({ message: 'Reconnecting... 2/5' }, true)).toBe('正在重新连接 2/5');
    expect(nativeErrorContent({ message: 'Reconnecting 3/5' }, true)).toBe('正在重新连接 3/5');
    expect(nativeErrorContent({ message: 'stream interrupted: unexpected status 429' }, true))
      .toBe('stream interrupted: unexpected status 429');
    expect(nativeErrorContent({ message: 'Reconnecting 2/5' }, false)).toBe('Reconnecting 2/5');
  });
  it('matches the native overloaded stream status only for the native kinds', () => {
    expect(nativeErrorContent({ message: 'Reconnecting 1/5',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } }, true))
      .toBe('服务器繁忙，正在重新连接 1/5');
    expect(nativeErrorContent({ message: 'capacity', codexErrorInfo: 'serverOverloaded' }, true))
      .toBe('服务器繁忙，正在重新连接');
    expect(nativeErrorContent({ message: 'limit', codexErrorInfo: 'usageLimitExceeded' }, true)).toBe('limit');
  });
  it('projects a terminal JSON error message while leaving the original error untouched', () => {
    const error = { message: 'unexpected status 400: {"error":{"message":"Native message","code":"bad_request"}}',
      additionalDetails: 'Original details', codexErrorInfo: 'badRequest' };
    expect(nativeErrorContent(error, false)).toBe('Native message');
    expect(error.message).toContain('unexpected status 400');
    expect(nativeErrorContent({ message: 'Command {failed}' }, false)).toBe('Command {failed}');
    expect(nativeErrorContent({ message: '{"message":"Unrelated JSON"}' }, false)).toBe('{"message":"Unrelated JSON"}');
    expect(nativeErrorContent(error, true)).toBe(error.message);
  });
});
