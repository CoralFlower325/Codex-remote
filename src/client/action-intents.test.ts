import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  storage = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
});
afterEach(() => vi.unstubAllGlobals());

const input = [{ type: 'text', text: 'Do this once' }];

describe('durable browser action identities', () => {
  it('restores an unconfirmed action after refresh without storing its payload', async () => {
    let { actionIntent } = await import('./action-intents');
    const first = actionIntent('turn/start', { threadId: 'thread', input })!;
    expect([...storage.values()].join('')).not.toContain('Do this once');
    vi.resetModules();
    ({ actionIntent } = await import('./action-intents'));
    expect(actionIntent('turn/start', { threadId: 'thread', input })!.id).toBe(first.id);
  });

  it('does not let a mode change bypass an unconfirmed input', async () => {
    const { actionIntent } = await import('./action-intents');
    actionIntent('turn/start', { threadId: 'thread', input });
    expect(() => actionIntent('turn/steer', { threadId: 'thread', input, expectedTurnId: 'turn' })).toThrow();
    expect(() => actionIntent('thread/queue/add', { threadId: 'thread', input })).toThrow();
    expect(actionIntent('turn/start', { threadId: 'different', input })).not.toBeNull();
  });

  it('reuses identity across regenerated message IDs and releases only a confirmed action', async () => {
    const { actionIntent } = await import('./action-intents');
    const first = actionIntent('turn/start', { threadId: 'thread', input, clientUserMessageId: 'first' })!;
    const retry = actionIntent('turn/start', { threadId: 'thread', input, clientUserMessageId: 'second' })!;
    expect(retry.id).toBe(first.id);
    retry.complete();
    const next = actionIntent('turn/start', { threadId: 'thread', input })!;
    expect(next.id).not.toBe(first.id);
    first.complete();
    expect(actionIntent('turn/start', { threadId: 'thread', input })!.id).toBe(next.id);
  });

  it('covers less common writes and keeps reads outside the ledger', async () => {
    const { actionIntent } = await import('./action-intents');
    for (const method of ['thread/revert', 'thread/compact/start', 'thread/queue/start', 'project/create']) {
      expect(actionIntent(method, { threadId: 'thread' }), method).not.toBeNull();
    }
    for (const method of ['thread/read', 'thread/resume', 'thread/unsubscribe', 'unrecognized/method']) {
      expect(actionIntent(method, {}), method).toBeNull();
    }
  });

  it('clears persisted side-chat retry metadata together with identities on logout', async () => {
    const { actionIntent, clearActionIntents } = await import('./action-intents');
    actionIntent('turn/start', { threadId: 'thread', input });
    storage.set('codex-remote:side-input-actions:v1', 'synthetic');
    clearActionIntents();
    expect(storage.size).toBe(0);
  });
});
