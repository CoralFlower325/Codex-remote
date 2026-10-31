import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceBootstrap } from './bootstrap.js';
import { WorkspaceSnapshots } from './workspace-snapshots.js';

afterEach(() => vi.useRealTimers());

function native() {
  return vi.fn(async (method: string) => method === 'thread/read'
    ? { thread: { id: 'chat' } }
    : { data: [], nextCursor: null });
}

describe('bounded native workspace snapshots', () => {
  it('shares a task read that outlives the bootstrap deadline with HTTP fallback', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const request = vi.fn(async (method: string) => method === 'thread/list'
      ? new Promise(resolve => { finish = resolve; }) : { data: [] });
    const snapshots = new WorkspaceSnapshots(request);
    const bootstrap = readWorkspaceBootstrap((method, params) =>
      method === 'thread/list' ? snapshots.list() : request(method));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await bootstrap).threads).toBeNull();
    const fallback = snapshots.list();
    expect(request.mock.calls.filter(([method]) => method === 'thread/list')).toHaveLength(1);
    finish({ data: [{ id: 'chat' }], nextCursor: 'cursor' });
    expect(await fallback).toMatchObject({ data: [{ id: 'chat' }], snapshot: { stale: false } });
  });

  it('expires a hung task read so retries do not rejoin it or accept its late result', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const request = native();
    request.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const snapshots = new WorkspaceSnapshots(request);
    const first = snapshots.list().catch(error => error);
    const fallback = snapshots.list().catch(error => error);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await first).toHaveProperty('message', 'Native read timed out. Please retry.');
    expect(await fallback).toBe(await first);
    request.mockResolvedValueOnce({ data: [{ id: 'current' }], nextCursor: 'current-cursor' });
    expect(await snapshots.list()).toMatchObject({ data: [{ id: 'current' }], nextCursor: 'current-cursor' });
    finish({ data: [{ id: 'obsolete' }], nextCursor: 'obsolete-cursor' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await snapshots.list()).toMatchObject({ data: [{ id: 'current' }], nextCursor: 'current-cursor' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds uncached cursor pages and allows the same cursor to be retried', async () => {
    vi.useFakeTimers();
    const request = native();
    request.mockImplementationOnce(async () => new Promise(() => {}));
    const snapshots = new WorkspaceSnapshots(request);
    const first = snapshots.list('older-cursor').catch(error => error);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await first).toHaveProperty('message', 'Native read timed out. Please retry.');
    expect(await snapshots.list('older-cursor')).toEqual({ data: [], nextCursor: null });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses fifty initial tasks and two hundred on subsequent native cursor pages', async () => {
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    await snapshots.list();
    await snapshots.list('cursor', true);
    expect(request).toHaveBeenNthCalledWith(1, 'thread/list', expect.objectContaining({
      limit: 50, modelProviders: [], archived: false
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'thread/list', expect.objectContaining({
      limit: 200, modelProviders: [], archived: true, cursor: 'cursor'
    }));
  });

  it('serves stale snapshots immediately but fresh reads join their background refresh', async () => {
    vi.useFakeTimers();
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    await snapshots.list();
    await vi.advanceTimersByTimeAsync(2001);
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    expect(await snapshots.list()).toMatchObject({ snapshot: { stale: true } });
    const fresh = snapshots.list(null, false, true);
    expect(request).toHaveBeenCalledTimes(2);
    finish({ data: [{ id: 'new' }], nextCursor: null });
    expect(await fresh).toMatchObject({ data: [{ id: 'new' }], snapshot: { stale: false } });
  });

  it('preserves invalidation while a native refresh is in flight', async () => {
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const loading = snapshots.list();
    snapshots.event('thread/started', { thread: { id: 'new' } });
    finish({ data: [], nextCursor: null });
    expect(await loading).toMatchObject({ snapshot: { stale: true } });
  });

  it('reuses a refresh completed while the stale response travelled to the browser', async () => {
    vi.useFakeTimers();
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    await snapshots.list();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await snapshots.list()).toMatchObject({ snapshot: { stale: true } });
    await Promise.resolve();
    await Promise.resolve();
    expect(await snapshots.list(null, false, true)).toMatchObject({ snapshot: { stale: false } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not reuse failed or deleted chat snapshots, including an unfinished read', async () => {
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    await snapshots.open('chat', 'read');
    snapshots.event('thread/deleted', { threadId: 'chat' });
    request.mockRejectedValueOnce(new Error('Not found'));
    await expect(snapshots.open('chat', 'read')).rejects.toThrow('Not found');

    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const loading = snapshots.open('chat', 'read');
    snapshots.event('thread/deleted', { threadId: 'chat' });
    finish({ thread: { id: 'chat' } });
    await expect(loading).rejects.toThrow('no longer available');
  });

  it('evicts the least recent of five chat snapshots and expires old display data', async () => {
    vi.useFakeTimers();
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    for (let i = 0; i < 6; i++) await snapshots.open(String(i), 'read');
    await snapshots.open('0', 'read');
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await snapshots.open('0', 'read');
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(8);
  });

  it('discards reverted chat and timing snapshots, including reads already in flight', async () => {
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    await snapshots.open('chat', 'read');
    await snapshots.readTimings('chat');
    snapshots.action('thread/revert', { threadId: 'chat', beforeTurnId: 'stopped' });
    await snapshots.open('chat', 'read');
    await snapshots.readTimings('chat');
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === 'thread/turns/list')).toHaveLength(2);
    snapshots.event('thread/reverted', { threadId: 'chat' });
    const pending: Array<(value: unknown) => void> = [];
    request.mockImplementation(async () => new Promise(resolve => { pending.push(resolve); }));
    const chat = snapshots.open('chat', 'read').catch(error => error);
    const timing = snapshots.readTimings('chat').catch(error => error);
    snapshots.event('thread/reverted', { threadId: 'chat' });
    for (const resolve of pending) resolve({ thread: { id: 'chat' }, data: [], nextCursor: null });
    expect(await chat).toHaveProperty('message', expect.stringContaining('no longer available'));
    expect(await timing).toHaveProperty('message', expect.stringContaining('no longer available'));
  });

  it('clears memory on bridge loss, and keeps timings independent from chat text', async () => {
    let finish!: (value: unknown) => void;
    const request = native();
    request.mockImplementation(async method => method === 'thread/turns/list'
      ? new Promise(resolve => { finish = resolve; })
      : method === 'thread/read' ? { thread: { id: 'chat' } } : { data: [], nextCursor: null });
    const snapshots = new WorkspaceSnapshots(request);
    const timing = snapshots.readTimings('chat');
    expect(await snapshots.open('chat', 'resume')).toMatchObject({ timingsPending: true, turns: [] });
    expect(request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
    finish({ data: [], nextCursor: null });
    await timing;
    snapshots.clear();
    await snapshots.open('chat', 'read');
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2);
  });

  it('invalidates mutation results without turning ordinary native reads into cache misses', async () => {
    const request = native();
    const snapshots = new WorkspaceSnapshots(request);
    await snapshots.open('chat', 'read');
    snapshots.action('thread/read', { threadId: 'chat' });
    expect(await snapshots.open('chat', 'read')).toMatchObject({ snapshot: { stale: false } });
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1);
    snapshots.action('thread/settings/update', { threadId: 'chat' });
    expect(await snapshots.open('chat', 'read')).toMatchObject({ snapshot: { stale: true } });
    await snapshots.open('chat', 'read', true);
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2);
  });
});
