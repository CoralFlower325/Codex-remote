import { describe, expect, it } from 'vitest';
import { streamFlushDelayMs } from './streaming-refresh';

describe('streamFlushDelayMs', () => {
  it('keeps the 60ms follow-the-tail cadence at the bottom', () => {
    expect(streamFlushDelayMs({ hidden: false, constrained: false, readingHistory: false })).toBe(60);
  });

  it('slows to 300ms while the reader is away reading history', () => {
    expect(streamFlushDelayMs({ hidden: false, constrained: false, readingHistory: true })).toBe(300);
  });

  it('keeps the constrained-network tier below the reading tier', () => {
    expect(streamFlushDelayMs({ hidden: false, constrained: true, readingHistory: false })).toBe(100);
    expect(streamFlushDelayMs({ hidden: false, constrained: true, readingHistory: true })).toBe(300);
  });

  it('gives the hidden tier priority over every other tier', () => {
    expect(streamFlushDelayMs({ hidden: true, constrained: false, readingHistory: false })).toBe(250);
    expect(streamFlushDelayMs({ hidden: true, constrained: true, readingHistory: true })).toBe(250);
  });
});
