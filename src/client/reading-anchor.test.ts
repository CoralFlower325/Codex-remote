import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureBlockAnchor, captureReadingAnchor, releaseReadingTail, restoreReadingAnchor, settleBlockAnchor, type ReadingAnchor } from './reading-anchor';

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

function blockLayout() {
  let scroll = 0;
  let content = 0;
  const viewportH = 600;
  class Node {
    children: Node[] = [];
    parentElement: Node | null = null;
    dataset: { scrollAnchor?: string };
    constructor(key: string | null, public top: number, public bottom: number) {
      this.dataset = key ? { scrollAnchor: key } : {};
    }
    getBoundingClientRect() { return { top: this.top - scroll, bottom: this.bottom - scroll }; }
    closest(): Node | null { return this.dataset.scrollAnchor ? this : this.parentElement?.closest() ?? null; }
    querySelectorAll(): Node[] {
      return this.children.flatMap(child => [...(child.dataset.scrollAnchor ? [child] : []), ...child.querySelectorAll()]);
    }
    querySelector(): Node | null { return this.querySelectorAll()[0] ?? null; }
    append(...nodes: Node[]) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
    contains(node: Node): boolean { return node === this || this.children.some(child => child.contains(node)); }
  }
  vi.stubGlobal('HTMLElement', Node);
  const stream = {
    get scrollTop() { return scroll; },
    set scrollTop(value: number) { scroll = Math.max(0, Math.min(value, Math.max(0, content - viewportH))); },
    get scrollHeight() { return content; },
    clientHeight: viewportH,
    getBoundingClientRect: () => ({ top: 0, bottom: viewportH })
  };
  const inner = new Node(null, 0, 0);
  return { Node, inner, stream: stream as unknown as HTMLElement,
    setScroll: (value: number) => { scroll = value; },
    setContent: (value: number) => { content = value; },
    scroll: () => scroll };
}

describe('block anchor (in-row drift)', () => {
  function giantTurn() {
    const l = blockLayout();
    const section = new l.Node('response-mega', 0, 2000);
    const activity = new l.Node('act-1', 100, 160);
    const final = new l.Node('final', 1500, 1700);
    section.append(activity, final);
    l.inner.append(section);
    l.setContent(2000);
    return { ...l, section, final };
  }

  it('captures the inner block itself, not the enclosing section anchor', () => {
    const l = giantTurn();
    l.setScroll(1400); // reader at the very bottom, final answer in view
    const block = captureBlockAnchor(l.stream, l.inner as unknown as HTMLElement);
    expect(block?.key).toBe('final');
    expect(block?.contentTop).toBe(1500);
  });

  it('anchors the last visible block, so growth above it (but below an earlier block) is paid', () => {
    const l = blockLayout();
    const section = new l.Node('response-mega', 0, 2600);
    const upper = new l.Node('upper', 1500, 1700);
    const lower = new l.Node('lower', 1850, 2050);
    section.append(upper, lower);
    l.inner.append(section);
    l.setContent(2600);
    l.setScroll(1400); // both blocks intersect the 600px viewport
    const inner = l.inner as unknown as HTMLElement;
    const anchor = captureBlockAnchor(l.stream, inner)!;
    expect(anchor.key).toBe('lower');
    // Growth lands between the two blocks: the upper one must not move,
    // the anchored lower one must be held exactly.
    lower.top += 200; lower.bottom += 200; section.bottom += 200; l.setContent(2800);
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).applied).toBe(200);
    expect(lower.top - l.scroll()).toBe(450);
  });

  it('holds the block position when its own section grows above it', () => {
    const l = giantTurn();
    l.setScroll(1400);
    const inner = l.inner as unknown as HTMLElement;
    const anchor = captureBlockAnchor(l.stream, inner)!;
    // The folded trace inside the same section expands above the answer:
    // the row start and the scroll offset do not move, the answer does.
    l.final.top += 683; l.final.bottom += 683; l.section.bottom += 683; l.setContent(2683);
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).applied).toBe(683);
    expect(l.scroll()).toBe(2083); // lands exactly on the new maximum
    expect(l.final.top - l.scroll()).toBe(100); // same viewport offset as captured
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).applied).toBe(0);
  });

  it('does not pay a shift the row-level restores already covered', () => {
    const l = giantTurn();
    l.setScroll(1400);
    const inner = l.inner as unknown as HTMLElement;
    const anchor = captureBlockAnchor(l.stream, inner)!;
    l.final.top += 683; l.final.bottom += 683; l.section.bottom += 683; l.setContent(2683);
    l.setScroll(2083); // another layer already compensated the full growth
    expect(settleBlockAnchor(l.stream, inner, anchor, 683).applied).toBe(0);
    expect(l.scroll()).toBe(2083);
  });

  it('ignores growth below the block and the reader\u2019s own scrolling', () => {
    const l = giantTurn();
    l.setScroll(1400);
    const inner = l.inner as unknown as HTMLElement;
    const anchor = captureBlockAnchor(l.stream, inner)!;
    l.setContent(2500); // growth entirely below the anchored block
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).applied).toBe(0);
    l.setScroll(900); // the reader scrolled up on purpose
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).applied).toBe(0);
    expect(l.scroll()).toBe(900);
    // Growth above still pays in full, landing on the reader's own view
    // (600 = where the reader's scroll-up had placed the block).
    l.final.top += 200; l.final.bottom += 200; l.section.bottom += 200; l.setContent(2700);
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).applied).toBe(200);
    expect(l.final.top - l.scroll()).toBe(600);
  });

  it('leaves an unpayable target standing instead of clamping to the window end', () => {
    const l = giantTurn();
    l.setScroll(1400);
    const inner = l.inner as unknown as HTMLElement;
    const anchor = captureBlockAnchor(l.stream, inner)!;
    // The block moved but the total height did not grow: no scroll room
    // exists, and writing the clamped maximum would teleport the reader.
    l.final.top += 683; l.final.bottom += 683; l.section.bottom += 683;
    const skipped = settleBlockAnchor(l.stream, inner, anchor, 0);
    expect(skipped.applied).toBe(0);
    expect(skipped.blocked).toBe(true); // fresh debt is retained, not forgiven
    expect(l.scroll()).toBe(1400);
  });

  it('pays a retained debt once the total height catches up', () => {
    const l = giantTurn();
    l.setScroll(1400);
    const inner = l.inner as unknown as HTMLElement;
    const anchor = captureBlockAnchor(l.stream, inner)!;
    // Same growth as the unpayable case, measured before the (virtual)
    // total height has been updated: blocked first…
    l.final.top += 683; l.final.bottom += 683; l.section.bottom += 683;
    expect(settleBlockAnchor(l.stream, inner, anchor, 0).blocked).toBe(true);
    expect(l.scroll()).toBe(1400);
    // …then the total height lands and the very same debt is paid in full.
    l.setContent(2683);
    const paid = settleBlockAnchor(l.stream, inner, anchor, 0);
    expect(paid).toEqual({ applied: 683, blocked: false });
    expect(l.scroll()).toBe(2083);
    expect(l.final.top - l.scroll()).toBe(100);
  });
});
