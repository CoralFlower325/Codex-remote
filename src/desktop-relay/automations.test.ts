import { afterEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('capnweb', () => ({ newMessagePortRpcSession: rpc.connect }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); rpc.connect.mockReset(); });

async function relay(service: unknown) {
  const close = vi.fn(), dispose = vi.fn(), postMessage = vi.fn();
  const host = { services: { localAutomations: service }, [Symbol.dispose]: dispose };
  rpc.connect.mockReturnValue(host);
  vi.stubGlobal('MessageChannel', class { port1 = { close }; port2 = {}; });
  vi.stubGlobal('window', { location: { origin: 'app://-' }, postMessage });
  await import('./automations');
  return { close, dispose, postMessage, request: window.__codexRemoteAutomationRequest };
}

describe('native automation host relay', () => {
  it('uses the allowlisted service and releases RPC resources', async () => {
    const disposeService = vi.fn(), list = vi.fn().mockResolvedValue({ items: [] });
    const { request, close, dispose, postMessage } = await relay({ list, [Symbol.dispose]: disposeService });
    expect(await request('list')).toEqual({ ok: true, result: { items: [] } });
    expect(list).toHaveBeenCalledExactlyOnceWith();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(disposeService).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails explicitly when the native service is unavailable', async () => {
    const { request, dispose, close } = await relay(null);
    expect(await request('list')).toMatchObject({ ok: false, error: expect.stringContaining('未提供原生自动任务接口') });
    expect(dispose).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it('bounds pending writes and never resubmits them', async () => {
    vi.useFakeTimers();
    const runNow = vi.fn(() => new Promise(() => {}));
    const { request, close } = await relay({ runNow, [Symbol.dispose]: vi.fn() });
    const result = request('runNow', { id: 'native-1' });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('操作结果无法确认') });
    expect(runNow).toHaveBeenCalledExactlyOnceWith({ id: 'native-1' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases a service that arrives after the read deadline without invoking it', async () => {
    vi.useFakeTimers();
    let resolve!: (service: unknown) => void;
    const pending = new Promise(res => { resolve = res; });
    const { request, close } = await relay(pending);
    const result = request('list');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('读取超时') });
    const list = vi.fn(), dispose = vi.fn();
    resolve({ list, [Symbol.dispose]: dispose });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
