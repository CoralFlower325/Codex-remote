import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReadingAnchor, releaseReadingTail, restoreReadingAnchor, type ReadingAnchor } from './reading-anchor';

afterEach(() => vi.unstubAllGlobals());

function layout() {
  let reads = 0;
  const stream = { scrollTop: 50_020, getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
  class Node {
    children: Node[] = [];
    parentElement: Node | null = null;
    dataset: { scrollAnchor?: string };
    constructor(key: string | null, readonly top: number, readonly bottom: number) {
      this.dataset = key ? { scrollAnchor: key } : {};
    }
    getBoundingClientRect() { reads++; return { top: this.top - stream.scrollTop, bottom: this.bottom - stream.scrollTop }; }
    closest(): Node | null { return this.dataset.scrollAnchor ? this : this.parentElement?.closest() ?? null; }
    querySelectorAll(): Node[] {
      return this.children.flatMap(child => [...(child.dataset.scrollAnchor ? [child] : []), ...child.querySelectorAll()]);
    }
    append(...nodes: Node[]) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
  }
  vi.stubGlobal('HTMLElement', Node);
  const inner = new Node(null, 0, 100_000), section = new Node('response', 0, 100_000);
  inner.append(section);
  return { Node, inner, section, stream, reads: () => reads,
    capture: () => captureReadingAnchor(stream as HTMLElement, inner as unknown as HTMLElement) };
}

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
  it('finds the visible message in a long live response without measuring every preceding message', () => {
    const l = layout();
    l.section.append(...Array.from({ length: 1000 }, (_, i) => new l.Node(`message-${i}`, i * 100, (i + 1) * 100)));
    const anchor = l.capture();
    expect(anchor?.key).toBe('message-500');
    expect(anchor?.offset).toBe(-20);
    expect(l.reads()).toBeLessThan(30);
  });
  it('retains an enclosing anchor instead of binary-searching overlapping container bottoms', () => {
    const l = layout(), group = new l.Node('activity', 50_000, 51_000);
    group.append(...Array.from({ length: 10 }, (_, i) => new l.Node(`command-${i}`, 50_000 + i * 100, 50_100 + i * 100)));
    l.section.append(new l.Node('before', 0, 50_000), group, new l.Node('after', 51_000, 100_000));
    l.stream.scrollTop = 50_520;
    expect(l.capture()?.key).toBe('activity');
    group.append(new l.Node('late-command', 50_990, 51_000));
    expect(l.capture()?.key).toBe('activity');
  });
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
