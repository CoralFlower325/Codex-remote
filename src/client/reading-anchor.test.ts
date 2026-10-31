import { describe, expect, it } from 'vitest';
import { releaseReadingTail, restoreReadingAnchor, type ReadingAnchor } from './reading-anchor';

function reader() {
  const stream = { scrollTop: 100, getBoundingClientRect: () => ({ top: 0 }) };
  let position = 120;
  const node = { getBoundingClientRect: () => ({ top: position - stream.scrollTop }) };
  const inner = { contains: () => true };
  const anchor = { key: 'message', node, offset: 20, scrollTop: 100 } as ReadingAnchor;
  const restore = () => restoreReadingAnchor(stream as HTMLElement, inner as unknown as HTMLElement, anchor);
  return { stream, anchor, restore, insert: (height: number) => { position += height; } };
}

describe('reading position', () => {
  it('releases historical compensation when returning toward the latest content', () => {
    let tail = '500px';
    const inner = { style: { getPropertyValue: () => tail, removeProperty: () => { tail = ''; } } };
    expect(releaseReadingTail(inner as unknown as HTMLElement)).toBe(true);
    expect(tail).toBe('');
    expect(releaseReadingTail(inner as unknown as HTMLElement)).toBe(false);
  });
  it('compensates inserted content once, before the next frame', () => {
    const r = reader();
    r.insert(500);
    expect(r.restore()).toBe(true);
    expect(r.stream.scrollTop).toBe(600);
    expect(r.restore()).toBe(false);
    r.insert(75);
    r.restore();
    expect(r.stream.scrollTop).toBe(675);
  });

  it('preserves touch movement that arrived before its scroll event', () => {
    const r = reader();
    r.stream.scrollTop = 70;
    r.insert(500);
    r.restore();
    expect(r.stream.scrollTop).toBe(570);
    expect(r.anchor.offset).toBe(50);
    expect(r.restore()).toBe(false);
    r.stream.scrollTop -= 15;
    expect(r.restore()).toBe(false);
    expect(r.stream.scrollTop).toBe(555);
  });

  it('rounds fractional layout targets before a browser truncates scrollTop', () => {
    let top = 100;
    const stream = {
      get scrollTop() { return top; },
      set scrollTop(value: number) { top = Math.trunc(value); },
      getBoundingClientRect: () => ({ top: 0 })
    };
    const node = { getBoundingClientRect: () => ({ top: 619.99998 - top }) };
    const inner = { contains: () => true };
    const anchor = { key: 'message', node, offset: 20, scrollTop: 100 } as ReadingAnchor;
    expect(restoreReadingAnchor(stream as HTMLElement, inner as unknown as HTMLElement, anchor)).toBe(true);
    expect(top).toBe(600);
    expect(restoreReadingAnchor(stream as HTMLElement, inner as unknown as HTMLElement, anchor)).toBe(false);
  });

  it('retains the blank space of a short page instead of clamping the anchor to the bottom', () => {
    let position = 20, top = 0, contentHeight = 100, tail = 0;
    const stream = {
      get scrollTop() { return top; },
      set scrollTop(value: number) { top = Math.max(0, Math.min(value, contentHeight + tail - 600)); },
      get scrollHeight() { return Math.max(600, contentHeight + tail); },
      clientHeight: 600, getBoundingClientRect: () => ({ top: 0 })
    };
    const node = { getBoundingClientRect: () => ({ top: position - top }) };
    const inner = { contains: () => true, style: {
      getPropertyValue: () => `${tail}px`, setProperty: (_name: string, value: string) => { tail = parseFloat(value); }
    } };
    const anchor = { key: 'last-message', node, offset: 20, scrollTop: 0 } as ReadingAnchor;
    position += 800; contentHeight += 800;
    expect(restoreReadingAnchor(stream as HTMLElement, inner as unknown as HTMLElement, anchor)).toBe(true);
    expect(top).toBe(800);
    expect(tail).toBe(500);
    expect(position - top).toBe(20);
    expect(restoreReadingAnchor(stream as HTMLElement, inner as unknown as HTMLElement, anchor)).toBe(false);
  });
});
