import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDeviceSnapshots, projectDeviceChat, projectDeviceThread, readDeviceChat,
  readDeviceWorkspace, saveDeviceChat, saveDeviceWorkspace, trimDeviceSnapshots,
  type DeviceSnapshots
} from './device-snapshots';
import type { Thread, ThreadHistoryItemEntry, ThreadHistoryPage, ThreadItem } from './types';

function thread(id = 'chat'): Thread {
  return {
    id, name: 'Conversation', preview: 'hello', cwd: '/workspace', projectId: 'project',
    model: 'model', modelProvider: 'provider', reasoningEffort: 'high', createdAt: 1, updatedAt: 2,
    status: { type: 'active', activeFlags: [{ type: 'waitingOnApproval' }] },
    permissionProfile: 'full-access', collaborationMode: {
      mode: 'default', settings: { model: 'model', reasoning_effort: 'high', developer_instructions: 'private' }
    }
  };
}

function entry(item: ThreadItem, turnId = 'done'): ThreadHistoryItemEntry {
  return { item, turnId, startedAtMs: 1000, completedAtMs: 2000 };
}

function page(items: ThreadHistoryItemEntry[] = []): ThreadHistoryPage {
  return {
    items, nextCursor: 'older-native-cursor', activeTurnId: null, turnsCursor: 'turn-native-cursor',
    turns: [{ id: 'done', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000 }]
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('fixed-device snapshot projection', () => {
  it('keeps task identity and display fields without authority or running state', () => {
    const projected = projectDeviceThread({
      ...thread(), turns: [{ id: 'turn', status: 'inProgress', items: [], startedAt: 1, completedAt: null, durationMs: null }]
    });
    expect(projected).toMatchObject({
      id: 'chat', modelProvider: 'provider', cwd: '/workspace', status: { type: 'notLoaded' }
    });
    expect(projected).not.toHaveProperty('permissionProfile');
    expect(projected).not.toHaveProperty('collaborationMode');
    expect(projected).not.toHaveProperty('turns');
  });

  it('preserves text/item identity and timing but excludes tool output, diffs, images and reasoning', () => {
    const source = page([
      entry({ type: 'userMessage', id: 'u', content: [
        { type: 'text', text: 'hello' },
        { type: 'image', url: 'data:image/png;base64,PRIVATE_BINARY' },
        { type: 'localImage', path: '/private/image.png' }
      ] }),
      entry({ type: 'agentMessage', id: 'a', text: 'answer', phase: 'final_answer' }),
      entry({ type: 'commandExecution', id: 'c', command: 'npm test', cwd: '/workspace',
        status: 'completed', aggregatedOutput: 'PRIVATE_OUTPUT', exitCode: 0, durationMs: 123 }),
      entry({ type: 'fileChange', id: 'f', status: 'completed',
        changes: [{ path: 'app.ts', kind: 'update', diff: 'PRIVATE_DIFF' }] }),
      entry({ type: 'reasoning', id: 'r', summary: ['PRIVATE_REASONING'], content: [] }),
      entry({ type: 'mcpToolCall', id: 'm', server: 'server', tool: 'tool', status: 'completed',
        arguments: { secret: 'PRIVATE_ARGUMENTS' }, result: 'PRIVATE_RESULT', error: null }),
      entry({ type: 'dynamicToolCall', id: 'd', tool: 'tool', status: 'completed',
        arguments: {}, contentItems: ['PRIVATE_TOOL_CONTENT'] }),
      entry({ type: 'imageView', id: 'image', path: '/private/image.png' })
    ]);
    const result = projectDeviceChat(thread(), source)!;
    expect(result.page.items.map(item => item.item.id)).toEqual(['u', 'a', 'c', 'f']);
    expect(result.page.items[0]).toEqual(entry({ type: 'userMessage', id: 'u',
      content: [{ type: 'text', text: 'hello' }] }));
    expect(result.page.items[2]?.item).toMatchObject({ aggregatedOutput: null, status: 'completed' });
    expect(result.page.turns).toEqual(source.turns);
    expect(result.page.nextCursor).toBeNull();
    expect(result.page.turnsCursor).toBeNull();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it.each([undefined, false, true])('keeps stripped execution details reloadable from snapshots (%s)', detailsDeferred => {
    const marker = detailsDeferred === undefined ? {} : { detailsDeferred };
    const source = page([
      entry({ type: 'commandExecution', id: 'command', command: 'npm test', cwd: '/workspace',
        status: 'completed', aggregatedOutput: 'PRIVATE_OUTPUT', exitCode: 0, durationMs: 123, ...marker }),
      entry({ type: 'fileChange', id: 'change', status: 'completed', ...marker,
        changes: [{ path: 'app.ts', kind: 'update', diff: 'PRIVATE_DIFF' }] })
    ]);
    const original = structuredClone(source);
    const result = projectDeviceChat(thread(), source)!;
    expect(result.page.items).toEqual([
      entry({ type: 'commandExecution', id: 'command', command: 'npm test', cwd: '/workspace',
        status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 123, detailsDeferred: true }),
      entry({ type: 'fileChange', id: 'change', status: 'completed', detailsDeferred: true,
        changes: [{ path: 'app.ts', kind: 'update' }] })
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(source).toEqual(original);
  });

  it('never restores active turns, ephemeral chats or subagent chats', () => {
    const source = {
      ...page([
        entry({ type: 'agentMessage', id: 'finished', text: 'done' }),
        entry({ type: 'agentMessage', id: 'live', text: 'still running' }, 'active')
      ]),
      activeTurnId: 'active',
      turns: [...page().turns, {
        id: 'active', status: 'inProgress' as const, startedAt: 3, completedAt: null, durationMs: null
      }]
    };
    const result = projectDeviceChat(thread(), source)!;
    expect(result.page.activeTurnId).toBeNull();
    expect(result.page.items.map(item => item.item.id)).toEqual(['finished']);
    expect(result.page.turns.map(turn => turn.id)).toEqual(['done']);
    expect(projectDeviceChat({ ...thread(), ephemeral: true }, source)).toBeNull();
    expect(projectDeviceChat({ ...thread(), source: {
      subAgent: { thread_spawn: { parent_thread_id: 'parent' } }
    } }, source)).toBeNull();
  });

  it('limits chat history to the latest 40 records without changing the source page', () => {
    const source = page(Array.from({ length: 80 }, (_, i) =>
      entry({ type: 'agentMessage', id: String(i), text: `reply ${i}` })));
    const result = projectDeviceChat(thread(), source)!;
    expect(result.page.items).toHaveLength(40);
    expect(result.page.items[0]?.item.id).toBe('40');
    expect(source.items).toHaveLength(80);
  });
});

describe('fixed-device storage limits', () => {
  const now = 100_000_000;
  const saved = (id: string, savedAt = now) => ({
    savedAt, value: projectDeviceChat(thread(id), page([entry({ type: 'agentMessage', id: 'a', text: 'hello' })]))!
  });

  it('expires old records, excludes non-persisted task kinds and retains three recent chats', () => {
    const source: DeviceSnapshots = {
      workspace: { savedAt: now, value: {
        threads: [thread(), { ...thread('temporary'), ephemeral: true }, ...Array.from({ length: 1100 }, (_, i) => thread(String(i)))],
        projects: [{ id: 'project', name: 'Project', roots: [{ path: '/workspace' }] }]
      } },
      chats: [saved('expired', now - 24 * 60 * 60 * 1000 - 1), saved('a'), saved('b'), saved('c'), saved('d')]
    };
    const result = trimDeviceSnapshots(source, now);
    expect(result.workspace?.value.threads).toHaveLength(1000);
    expect(result.workspace?.value.threads.some(chat => chat.ephemeral)).toBe(false);
    expect(result.chats.map(chat => chat.value.thread.id)).toEqual(['b', 'c', 'd']);
    expect(trimDeviceSnapshots(source, now + 24 * 60 * 60 * 1000 + 1)).toEqual({ workspace: null, chats: [] });
  });

  it('caps UTF-8 bytes and evicts a huge body without mutating its input', () => {
    const huge = saved('huge');
    huge.value.page.items = [entry({ type: 'agentMessage', id: 'a', text: '\u4e2d'.repeat(500_000) })];
    const result = trimDeviceSnapshots({ workspace: null, chats: [huge] }, now);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(result.chats[0]?.value.page.items).toHaveLength(0);
    expect(huge.value.page.items).toHaveLength(1);
  });

  it('restores lazy detail reads for an existing snapshot without writing it back or fetching bodies', async () => {
    vi.resetModules();
    const { readDeviceChat: readLegacyDeviceChat } = await import('./device-snapshots');
    const legacy: DeviceSnapshots = {
      workspace: null, chats: [{ savedAt: Date.now(), value: {
        thread: projectDeviceThread(thread()),
        page: { ...page([
          entry({ type: 'commandExecution', id: 'command', command: 'npm test', cwd: '/workspace',
            status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 123 }),
          entry({ type: 'fileChange', id: 'change', status: 'completed',
            changes: [{ path: 'app.ts', kind: 'update' }] })
        ]), nextCursor: null, turnsCursor: null }
      } }]
    };
    const original = structuredClone(legacy);
    const put = vi.fn();
    const store = {
      get: vi.fn(() => {
        const request = { result: legacy, onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }),
      put
    };
    const db = { close: vi.fn(), transaction: vi.fn(() => ({ objectStore: () => store })) };
    vi.stubGlobal('indexedDB', { open: vi.fn(() => {
      const request = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }) });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const result = await readLegacyDeviceChat('chat');
    expect(result?.page.items).toEqual([
      entry({ type: 'commandExecution', id: 'command', command: 'npm test', cwd: '/workspace',
        status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 123, detailsDeferred: true }),
      entry({ type: 'fileChange', id: 'change', status: 'completed', detailsDeferred: true,
        changes: [{ path: 'app.ts', kind: 'update' }] })
    ]);
    expect(put).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(legacy).toEqual(original);
  });

  it('degrades cleanly when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await saveDeviceWorkspace([thread()], []);
    await saveDeviceChat(thread(), page());
    expect(await readDeviceWorkspace()).toBeNull();
    expect(await readDeviceChat('chat')).toBeNull();
    await expect(clearDeviceSnapshots()).resolves.toBeUndefined();
  });
});
