import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryScroll, historyScrollDelta, laterHistoryLoadReady } from './history-scroll';

afterEach(() => vi.useRealTimers());

describe('history insertion during scrolling', async () => {
  it('keeps upward intent through Safari top overscroll and its rebound', () => {
    expect(historyScrollDelta(80, -75, 1000)).toBe(-80);
    expect(historyScrollDelta(-75, -20, 1000)).toBe(0);
    expect(historyScrollDelta(-20, 0, 1000)).toBe(0);
    expect(historyScrollDelta(0, 30, 1000)).toBe(30);
    expect(historyScrollDelta(-20, 0, -10)).toBe(0);
  });

  it('accumulates fine touch motion at a boundary and detects a deliberate reversal', () => {
    const scroll = new HistoryScroll(() => {});
    scroll.startTouch(100);
    expect(scroll.moveTouch(101)).toBeNull();
    expect(scroll.moveTouch(102)).toBeNull();
    expect(scroll.moveTouch(103)).toBe(-1);
    expect(scroll.moveTouch(102)).toBeNull();
    expect(scroll.moveTouch(100)).toBe(1);
    scroll.endTouch();
    expect(scroll.moveTouch(200)).toBeNull();
    scroll.cancel();
  });

  it('retains touch direction until momentum settles, including delayed scroll corrections', async () => {
    vi.useFakeTimers();
    const scroll = new HistoryScroll(() => {});
    scroll.startTouch(100);
    expect(scroll.hasTouchIntent).toBe(false);
    scroll.moveTouch(130);
    scroll.endTouch();
    expect(scroll.hasTouchIntent).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    scroll.activity();
    await vi.advanceTimersByTimeAsync(159);
    expect(scroll.hasTouchIntent).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(scroll.hasTouchIntent).toBe(false);
    scroll.startTouch(100);
    scroll.moveTouch(130);
    scroll.cancel();
    expect(scroll.hasTouchIntent).toBe(false);
  });

  it('waits while a finger remains down, including when it pauses', async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const scroll = new HistoryScroll(ready);
    scroll.startTouch();
    const pending = scroll.waitForIdle().then(ready);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ready).not.toHaveBeenCalled();
    scroll.endTouch();
    await vi.advanceTimersByTimeAsync(159);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(ready).toHaveBeenCalledWith(true);
  });

  it('also waits for momentum after touchend and wheel bursts', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const scroll = new HistoryScroll(settled);
    scroll.startTouch();
    scroll.endTouch();
    const ready = vi.fn();
    const pending = scroll.waitForIdle().then(ready);
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(80);
      scroll.activity();
      expect(ready).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(160);
    await pending;
    expect(ready).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('rechecks activity when a pending network response is ready', async () => {
    vi.useFakeTimers();
    const scroll = new HistoryScroll(() => {});
    scroll.activity();
    await vi.advanceTimersByTimeAsync(160);
    scroll.startTouch();
    const commit = vi.fn();
    const pending = scroll.waitForIdle().then(commit);
    await vi.advanceTimersByTimeAsync(500);
    expect(commit).not.toHaveBeenCalled();
    scroll.endTouch();
    await vi.advanceTimersByTimeAsync(160);
    await pending;
    expect(commit).toHaveBeenCalledWith(true);
  });

  it('releases abandoned history without committing after selection changes', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const scroll = new HistoryScroll(settled);
    scroll.startTouch();
    const pending = scroll.waitForIdle();
    scroll.cancel();
    await expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
  });
});

describe('later history paging gate', () => {
  it('never loads a newer page while the reader is travelling upward', () => {
    expect(laterHistoryLoadReady(0, 874, true)).toBe(false);
    expect(laterHistoryLoadReady(120, 874, true)).toBe(false);
  });

  it('does not fire at the top of a short trimmed window', () => {
    // An 800-item folded window can be ~1,848px tall in an 874px viewport:
    // pinned to its top, the reader is still 974px from its end.
    expect(laterHistoryLoadReady(974, 874, false)).toBe(false);
    expect(laterHistoryLoadReady(438, 874, false)).toBe(false);
  });

  it('loads when the reader is genuinely near the window end', () => {
    expect(laterHistoryLoadReady(437, 874, false)).toBe(true);
    expect(laterHistoryLoadReady(0, 874, false)).toBe(true);
  });
});
