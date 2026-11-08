import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { turnInput } from './slash-commands';

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
const input = turnInput('One side-chat input', []);

describe('side-chat acknowledgement recovery', () => {
  it('keeps turn/start after a native turn event arrives before the lost RPC acknowledgement', async () => {
    const { sideChatAction } = await import('./side-chat-actions');
    const first = sideChatAction('side', input, null, { model: 'model' });
    const retry = sideChatAction('side', input, 'native-started-turn', { model: 'model' });
    expect(retry.method).toBe('turn/start');
    expect(retry.params).toEqual(first.params);
    expect([...storage.values()].join('')).not.toContain('One side-chat input');
  });

  it('restores the original steer target and stable user row identity after refresh', async () => {
    let { sideChatAction } = await import('./side-chat-actions');
    const first = sideChatAction('side', input, 'old-turn', {});
    vi.resetModules();
    ({ sideChatAction } = await import('./side-chat-actions'));
    const retry = sideChatAction('side', input, 'new-turn', {});
    expect(retry.method).toBe('turn/steer');
    expect(retry.expectedTurnId).toBe('old-turn');
    expect(retry.params).toEqual(first.params);
  });

  it('treats the same text as a new action only after confirmation', async () => {
    const { sideChatAction } = await import('./side-chat-actions');
    const first = sideChatAction('side', input, null, {});
    first.complete();
    const next = sideChatAction('side', input, 'turn', {});
    expect(next.method).toBe('turn/steer');
    expect(next.params.clientUserMessageId).not.toBe(first.params.clientUserMessageId);
  });
});
