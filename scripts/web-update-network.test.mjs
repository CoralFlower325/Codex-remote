import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReleaseFetch } from './web-update-network.mjs';
import { withNetworkRetry } from '../desktop/update-inputs.mjs';
import { networkFailure, updateError } from '../desktop/update-progress.mjs';

afterEach(() => { vi.useRealTimers(); });

function fixture(fetcher, options = {}) {
  const dispatcher = {};
  const createDispatcher = vi.fn(() => dispatcher);
  return { fetch: createReleaseFetch({ fetcher, createDispatcher, ...options }),
    createDispatcher, dispatcher };
}

describe('web update download deadlines', () => {
  it('falls back to a direct request when the proxy dispatcher rejects before headers', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('proxy dispatcher unavailable'))
      .mockResolvedValueOnce(new Response('direct result'));
    const f = fixture(fetcher);
    const response = await f.fetch('https://example.test/release');
    expect(await response.text()).toBe('direct result');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].dispatcher).toBe(f.dispatcher);
    expect(fetcher.mock.calls[1][1]).not.toHaveProperty('dispatcher');
    expect(f.createDispatcher).toHaveBeenCalledOnce();
  });

  it('keeps the original headers deadline while a direct fallback stalls', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('proxy failed')), 20_000);
      }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const f = fixture(fetcher);
    const failure = f.fetch(new URL('https://example.test/release')).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]).not.toHaveProperty('dispatcher');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await failure).toMatchObject({ code: 'ETIMEDOUT' });
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds missing headers, aborts the transport and classifies the timeout for existing retries', async () => {
    vi.useFakeTimers();
    let transportSignal;
    const fetcher = vi.fn((_url, options) => {
      transportSignal = options.signal;
      return new Promise(() => {});
    });
    const f = fixture(fetcher);
    const result = f.fetch('https://example.test/release');
    const failure = result.catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await failure;
    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(error.message).toContain('response headers');
    expect(networkFailure(error)).toBe(true);
    expect(updateError(error)).toContain('\u7f51\u7edc');
    expect(transportSignal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a late response after a headers timeout instead of retaining its connection', async () => {
    vi.useFakeTimers();
    let resolve;
    const cancelled = vi.fn();
    const f = fixture(() => new Promise(done => { resolve = done; }));
    const failure = f.fetch('https://example.test/release').catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await failure).code).toBe('ETIMEDOUT');
    resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled body, releases its reader and permits the existing single retry', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelled })))
      .mockResolvedValueOnce(new Response('recovered'));
    const f = fixture(fetcher);
    const report = { output: vi.fn(), note: vi.fn() };
    const result = withNetworkRetry(async () => (await f.fetch('https://example.test/release')).text(), report);
    const success = expect(result).resolves.toBe('recovered');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(report.note).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1500);
    await success;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.createDispatcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps flowing transfers alive beyond one idle interval without buffering ahead', async () => {
    vi.useFakeTimers();
    let source;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(value) { source = value; }
    }, { highWaterMark: 0 })));
    const f = fixture(fetcher);
    const response = await f.fetch('https://example.test/release');
    const reader = response.body.getReader();
    for (let i = 0; i < 3; i++) {
      const chunk = reader.read();
      await vi.advanceTimersByTimeAsync(50_000);
      source.enqueue(new Uint8Array([i]));
      expect(await chunk).toEqual({ done: false, value: new Uint8Array([i]) });
    }
    const final = reader.read();
    source.close();
    expect(await final).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count empty body chunks as download activity', async () => {
    vi.useFakeTimers();
    let source;
    const cancelled = vi.fn();
    const f = fixture(async () => new Response(new ReadableStream({
      start(value) { source = value; }, cancel: cancelled
    }, { highWaterMark: 0 })));
    const response = await f.fetch('https://example.test/release');
    const reader = response.body.getReader();
    const empty = reader.read();
    await vi.advanceTimersByTimeAsync(50_000);
    source.enqueue(new Uint8Array());
    expect((await empty).value.byteLength).toBe(0);
    const failure = reader.read().catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await failure).code).toBe('ETIMEDOUT');
    expect(cancelled).toHaveBeenCalledOnce();
    reader.releaseLock();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves Response metadata, JSON and clone consumption with bounded streaming', async () => {
    vi.useFakeTimers();
    const original = new Response('{"version":"0.2.8"}', {
      status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', 'x-release': 'yes' }
    });
    Object.defineProperties(original, {
      url: { value: 'https://example.test/final' }, redirected: { value: true }
    });
    const f = fixture(async () => original);
    const response = await f.fetch('https://example.test/release', { redirect: 'follow' });
    expect(response).toBeInstanceOf(Response);
    expect(response).toMatchObject({ status: 201, statusText: 'Created', ok: true,
      url: original.url, redirected: true, type: original.type });
    expect(response.headers.get('x-release')).toBe('yes');
    const clone = response.clone();
    expect(clone.url).toBe(original.url);
    expect(await response.json()).toEqual({ version: '0.2.8' });
    expect(await clone.json()).toEqual({ version: '0.2.8' });
    expect(response.bodyUsed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates caller cancellation during headers and removes its listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let transportSignal;
    const f = fixture((_url, options) => {
      transportSignal = options.signal;
      return new Promise(() => {});
    });
    const failure = f.fetch('https://example.test/release', { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('operator cancelled');
    controller.abort(reason);
    expect(await failure).toBe(reason);
    expect(transportSignal.reason).toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an unread body when the caller aborts and clears its deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancelled = vi.fn();
    let transportSignal;
    const f = fixture(async (_url, options) => {
      transportSignal = options.signal;
      return new Response(new ReadableStream({ cancel: cancelled }));
    });
    const response = await f.fetch('https://example.test/release', { signal: controller.signal });
    const reason = new Error('operator cancelled');
    controller.abort(reason);
    await expect(response.text()).rejects.toBe(reason);
    expect(transportSignal.reason).toBe(reason);
    expect(cancelled).toHaveBeenCalledWith(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases unread responses at the idle deadline without starting another request', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const f = fixture(fetcher);
    const response = await f.fetch('https://example.test/release');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(response.text()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a body error and removes cancellation listeners after failure or completion', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let source;
    const upstream = new Response(new ReadableStream({ start(value) { source = value; } }));
    const fetcher = vi.fn().mockResolvedValueOnce(upstream).mockResolvedValueOnce(new Response('done'));
    const f = fixture(fetcher);
    const response = await f.fetch('https://example.test/release', { signal: controller.signal });
    const failure = response.text().catch(error => error);
    const reason = new Error('socket hang up');
    source.error(reason);
    expect(await failure).toBe(reason);
    expect(upstream.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(await (await f.fetch('https://example.test/release', { signal: controller.signal })).text()).toBe('done');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the transport on consumer cancellation and passes options without retries', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const f = fixture(fetcher);
    const response = await f.fetch('https://example.test/release', {
      method: 'POST', body: 'once', headers: { 'x-test': 'value' }, redirect: 'error'
    });
    await response.body.cancel('closed');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'POST', body: 'once', headers: { 'x-test': 'value' }, redirect: 'error',
      dispatcher: f.dispatcher
    });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledWith('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry failed non-GET requests and clears the headers deadline', async () => {
    vi.useFakeTimers();
    const failure = new Error('fetch failed');
    const fetcher = vi.fn().mockRejectedValue(failure);
    const f = fixture(fetcher);
    await expect(f.fetch('https://example.test/release', { method: 'POST', body: 'once' })).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open a transport after cancellation and cleans up empty responses', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const f = fixture(fetcher);
    const reason = new Error('already cancelled');
    await expect(f.fetch('https://example.test/release', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.createDispatcher).not.toHaveBeenCalled();
    expect((await f.fetch('https://example.test/release')).status).toBe(204);
    expect(vi.getTimerCount()).toBe(0);
  });
});
