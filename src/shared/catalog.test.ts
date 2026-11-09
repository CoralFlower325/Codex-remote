import { describe, expect, it, vi } from 'vitest';
import { readCompleteCatalog } from './catalog';

describe('complete native catalogs', () => {
  it('follows every cursor, de-duplicates identities and commits one snapshot', async () => {
    const read = vi.fn(async (_method: string, params: unknown) => {
      const cursor = (params as { cursor?: string }).cursor;
      if (!cursor) return { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'page-2' };
      if (cursor === 'page-2') return { data: [{ id: 'b' }, { id: 'c' }], nextCursor: 'page-3' };
      return { data: [{ id: 'c' }, { id: 'd' }], nextCursor: null };
    });

    const snapshot = await readCompleteCatalog<{ id: string }>(read as never, 'projects', {
      generation: () => 'generation-1',
      now: () => 42
    });

    expect(snapshot).toEqual({
      data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      nextCursor: null,
      complete: true,
      generation: 'generation-1',
      fetchedAt: 42
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('rejects cursor cycles and malformed or over-long catalogs without returning partial data', async () => {
    await expect(readCompleteCatalog(vi.fn(async () => ({ data: [], nextCursor: 'same' })) as never, 'models', {
      maxPages: 4
    })).rejects.toThrow('repeated a cursor');
    await expect(readCompleteCatalog(vi.fn(async () => ({ items: [] })) as never, 'models'))
      .rejects.toThrow('invalid page');
    let page = 0;
    await expect(readCompleteCatalog(vi.fn(async () => ({ data: [], nextCursor: `next-${page++}` })) as never, 'projects', {
      maxPages: 2
    })).rejects.toThrow('page limit');
  });
});
