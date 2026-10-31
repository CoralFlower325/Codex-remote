import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionConnections } from './session-connections.js';

afterEach(() => vi.useRealTimers());
describe('live authentication revocation', () => {
  it('denies another message immediately and closes an idle connection within five seconds', () => {
    vi.useFakeTimers();
    const registry = new SessionConnections();
    const peer = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    const idle = { ...peer, close: vi.fn() };
    let valid = true;
    registry.add(peer, () => valid);
    registry.add(idle, () => valid);
    expect(registry.allowed(peer)).toBe(true);
    valid = false;
    expect(registry.allowed(peer)).toBe(false);
    expect(registry.allowed(peer)).toBe(false);
    expect(peer.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(idle.close).toHaveBeenCalledWith(1008, 'Authentication expired');
    registry.dispose();
  });
  it('closes on unreadable authentication storage and releases disconnected checks', () => {
    vi.useFakeTimers();
    const registry = new SessionConnections();
    const peer = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    const check = vi.fn(() => { throw new Error('unreadable'); });
    registry.add(peer, check);
    expect(registry.allowed(peer)).toBe(false);
    registry.delete(peer);
    registry.dispose();
    vi.advanceTimersByTime(10_000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
