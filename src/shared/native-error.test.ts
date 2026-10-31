import { describe, expect, it } from 'vitest';
import { NativeRpcError, nativeRpcErrorMessage, nativeRpcFailure, nativeTurnError, nativeErrorPresentation } from './native-error';
import { projectTurnTiming, runtimeTurnError, type TurnTiming } from './turn-timing';
import { mergeTurnTimings } from '../client/remote-state';

const turn: TurnTiming = { id: 't', status: 'inProgress', startedAt: 1, completedAt: null, durationMs: null };
describe('native runtime error fidelity', () => {
  it('preserves native 429 and details without inferring a status for usage limits', () => {
    const error = nativeTurnError({ message: 'Native message', codexErrorInfo: {
      httpConnectionFailed: { httpStatusCode: 429, privatePayload: 'excluded' } }, additionalDetails: 'Request id: synthetic' })!;
    expect(nativeErrorPresentation(error)).toMatchObject({ httpStatusCode: 429, title: '模型请求连接失败' });
    expect(JSON.stringify(error)).not.toContain('privatePayload');
    expect(nativeErrorPresentation({ message: 'Limit', codexErrorInfo: 'usageLimitExceeded' }))
      .toMatchObject({ title: '使用额度已达上限', httpStatusCode: undefined });
    expect(nativeErrorPresentation(nativeTurnError({ message: 'Future', codexErrorInfo: { futureError: null } })!).kind).toBe('futureError');
  });
  it('tracks native retry state without ending or resubmitting the turn, and clears only recovered retries', () => {
    let state = runtimeTurnError({ t: turn }, 'error', {
      turnId: 't', willRetry: true, error: { message: 'Retry 1/5', codexErrorInfo: 'serverOverloaded' }
    });
    expect(state.t).toMatchObject({ status: 'inProgress', errorWillRetry: true });
    expect(runtimeTurnError(state, 'thread/tokenUsage/updated', { turnId: 't' })).toBe(state);
    expect(runtimeTurnError(state, 'item/agentMessage/delta', { turnId: 'other' })).toBe(state);
    state = runtimeTurnError(state, 'item/agentMessage/delta', { turnId: 't' });
    expect(state.t?.error).toBeUndefined();
    state = runtimeTurnError(state, 'error', { turnId: 't', willRetry: false, error: { message: 'Failed' } });
    expect(runtimeTurnError(state, 'item/completed', { turnId: 't' })).toBe(state);
    expect(runtimeTurnError(state, 'error', { turnId: 't', error: { secret: 'invalid' } })).toBe(state);
  });
  it('retains bounded failed-turn history without leaking full native turn payloads', () => {
    const projected = projectTurnTiming({ ...turn, status: 'failed', error: {
      message: 'failed', codexErrorInfo: 'rateLimitExceeded', additionalDetails: 'detail'
    }, items: ['private body'] } as TurnTiming);
    expect(projected.error?.codexErrorInfo).toBe('rateLimitExceeded');
    expect(projected).not.toHaveProperty('items');
  });
  it('keeps a native retry visible through late timing snapshots until progress or a final result', () => {
    const retry = { t: { ...turn, error: { message: 'Retrying' }, errorWillRetry: true } };
    expect(mergeTurnTimings(retry, [turn], retry).t).toMatchObject({ error: { message: 'Retrying' }, errorWillRetry: true });
    expect(mergeTurnTimings(retry, [{ ...turn, status: 'completed' }], retry).t?.error).toBeUndefined();
  });
  it('keeps RPC code and public error metadata across bridge hops without duplicated suffixes', () => {
    const input = { message: 'Request rejected', code: -32000, data: {
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } }, additionalDetails: 'detail', rawResult: 'private'
    } };
    const forwarded = nativeRpcFailure(new NativeRpcError(input));
    expect(forwarded).toMatchObject({ message: input.message, code: -32000, data: { additionalDetails: 'detail' } });
    expect(nativeRpcErrorMessage(forwarded)).toBe('Request rejected (模型请求连接失败 · HTTP 429 · RPC -32000)');
    expect(JSON.stringify(forwarded)).not.toContain('private');
  });
});
