import { describe, expect, it, vi } from 'vitest';
import { MetadataReader, readThreadListPage, readWorkspaceBootstrap } from './bootstrap.js';

describe('metadata bootstrap handoff', () => {
  it('reuses a slow native lookup after the HTTP bootstrap returns', async () => {
    let finish!: (value: unknown) => void;
    const native = vi.fn(async (method: string) => method === 'model/list'
      ? new Promise(resolve => { finish = resolve; }) : { data: [], nextCursor: null });
    const reader = new MetadataReader(native);
    const initial = await readWorkspaceBootstrap(reader.read);
    expect(initial.models).toBeNull();
    const followup = reader.read('model/list', { limit: 100, includeHidden: false });
    expect(native.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1);
    finish({ data: [{ id: 'available' }] });
    expect(await followup).toEqual({ data: [{ id: 'available' }] });
  });

  it('hands off results completed during transit, expires them and invalidates project reads', async () => {
    vi.useFakeTimers();
    try {
      const native = vi.fn(async () => ({ data: [] }));
      const reader = new MetadataReader(native);
      const params = { limit: 200 };
      await reader.read('project/list', params);
      await reader.read('project/list', params);
      expect(native).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      await reader.read('project/list', params);
      expect(native).toHaveBeenCalledTimes(2);
      reader.clear('project/list');
      await reader.read('project/list', params);
      expect(native).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('retries errors and never shares actions, chat reads or different metadata parameters', async () => {
    const native = vi.fn(async () => ({ data: [] }))
      .mockRejectedValueOnce(new Error('Catalog unavailable'));
    const reader = new MetadataReader(native);
    await expect(reader.read('model/list', { limit: 100 })).rejects.toThrow('Catalog unavailable');
    await reader.read('model/list', { limit: 100 });
    await reader.read('model/list', { limit: 50 });
    await reader.read('thread/read', { threadId: 'a' });
    await reader.read('thread/read', { threadId: 'a' });
    await reader.read('turn/start', { threadId: 'a' });
    await reader.read('turn/start', { threadId: 'a' });
    expect(native).toHaveBeenCalledTimes(7);
    reader.clear();
    await reader.read('model/list', { limit: 100 });
    expect(native).toHaveBeenCalledTimes(8);
  });

  it('expires a hung metadata read and does not let its late result replace a retry', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: unknown) => void;
      const native = vi.fn()
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
        .mockResolvedValue({ data: [{ id: 'current' }] });
      const reader = new MetadataReader(native);
      const params = { limit: 100, includeHidden: false };
      const first = reader.read('model/list', params).catch(error => error);
      const joined = reader.read('model/list', params).catch(error => error);
      expect(native).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await first).toHaveProperty('message', 'Native read timed out. Please retry.');
      expect(await joined).toBe(await first);
      expect(await reader.read('model/list', params)).toEqual({ data: [{ id: 'current' }] });
      finish({ data: [{ id: 'obsolete' }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(await reader.read('model/list', params)).toEqual({ data: [{ id: 'current' }] });
      expect(native).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('leaves model actions on their native lifetime rather than the read deadline', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: unknown) => void;
      const reader = new MetadataReader(() => new Promise(resolve => { finish = resolve; }));
      let completed = false;
      const action = reader.read('turn/start', { threadId: 'chat' }).then(result => {
        completed = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(9000);
      expect(completed).toBe(false);
      finish({ turn: { id: 'turn' } });
      expect(await action).toEqual({ turn: { id: 'turn' } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('initial workspace request', () => {
  it('keeps native cursors, archive selection and all providers for HTTP pagination', async () => {
    const request = vi.fn(async () => ({ data: [], nextCursor: null }));
    await readThreadListPage(request, 'native-cursor', true);
    expect(request).toHaveBeenCalledWith('thread/list', {
      limit: 200, sortKey: 'updated_at', sortDirection: 'desc',
      useStateDbOnly: true, modelProviders: [], archived: true, cursor: 'native-cursor'
    });
  });
  it('returns the task page without waiting for a slow model catalog', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    try {
      const result = await readWorkspaceBootstrap(async method => method === 'model/list'
        ? new Promise(resolve => { finish = resolve; }) : { data: [], nextCursor: null });
      expect(result.threads).toEqual({ data: [], nextCursor: null });
      expect(result.models).toBeNull();
      finish({ data: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('fetches the first all-provider page and metadata together without loading chat history', async () => {
    const request = vi.fn(async (method: string) => ({
      data: [{ id: method }], nextCursor: method === 'thread/list' ? 'next-page' : null
    }));
    const result = await readWorkspaceBootstrap(request);
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/list', 'model/list', 'project/list']);
    expect(request).toHaveBeenCalledWith('thread/list', {
      limit: 50, sortKey: 'updated_at', sortDirection: 'desc',
      useStateDbOnly: true, modelProviders: [], archived: false
    });
    expect(result.threads).toEqual({ data: [{ id: 'thread/list' }], nextCursor: 'next-page' });
  });

  it('keeps the workspace available when one native metadata request fails', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'model/list') throw new Error('Catalog unavailable');
      return { data: [], nextCursor: null };
    });
    const result = await readWorkspaceBootstrap(request);
    expect(result.models).toBeNull();
    expect(result.threads).toEqual({ data: [], nextCursor: null });
    if (result.projects) expect(result.projects).toMatchObject({ data: [], nextCursor: null, complete: true });
  });

  it('does not block the workspace indefinitely when the native catalog is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const result = readWorkspaceBootstrap(async (method) =>
        method === 'model/list' ? new Promise(() => {}) : { data: [], nextCursor: null });
      await vi.advanceTimersByTimeAsync(1500);
      expect((await result).models).toBeNull();
      expect((await result).threads).toEqual({ data: [], nextCursor: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
