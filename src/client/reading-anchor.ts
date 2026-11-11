export interface ReadingAnchor {
  key: string;
  node: HTMLElement;
  offset: number;
  scrollTop: number;
}

function firstVisibleAnchor(child: HTMLElement, top: number, bottom: number): HTMLElement | null {
  const nodes = child.querySelectorAll<HTMLElement>('[data-scroll-anchor]');
  let low = 0, high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (nodes[middle]!.getBoundingClientRect().top <= top + 1) low = middle + 1;
    else high = middle;
  }
  const outerAnchor = (node: HTMLElement | undefined) => {
    if (!node) return null;
    let parent = node.parentElement?.closest<HTMLElement>('[data-scroll-anchor]');
    while (parent && parent !== child) {
      node = parent;
      parent = node.parentElement?.closest<HTMLElement>('[data-scroll-anchor]');
    }
    return node;
  };
  // Search positions, then retain an enclosing anchor when present.
  // Container bottoms overlap their children and cannot be binary-searched.
  for (const index of [Math.max(0, low - 1), low]) {
    const node = outerAnchor(nodes[index]);
    if (node) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > top + 1 && rect.top < bottom) return node;
    }
  }
  return null;
}

export function releaseReadingTail(inner: HTMLElement): boolean {
  if (!inner.style.getPropertyValue('--reading-tail')) return false;
  inner.style.removeProperty('--reading-tail');
  return true;
}

export function captureReadingAnchor(stream: HTMLElement, inner: HTMLElement): ReadingAnchor | null {
  const viewport = stream.getBoundingClientRect();
  const visible = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom;
  };
  let low = 0;
  let high = inner.children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (inner.children[middle]!.getBoundingClientRect().bottom <= viewport.top + 1) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < inner.children.length; index++) {
    const child = inner.children[index]!;
    if (child.getBoundingClientRect().top >= viewport.bottom) break;
    if (!(child instanceof HTMLElement) || !visible(child)) continue;
    const node = firstVisibleAnchor(child, viewport.top, viewport.bottom)
      ?? (child.dataset.scrollAnchor ? child : null);
    if (node) return { key: node.dataset.scrollAnchor!, node, offset: node.getBoundingClientRect().top - viewport.top,
      scrollTop: stream.scrollTop };
  }
  return null;
}

export interface BlockAnchor {
  key: string;
  node: HTMLElement;
  /** The block's top in content coordinates. Unlike a viewport offset
   * this does not move when the reader (or a compensator) scrolls — only
   * layout growth above the block moves it, which is exactly the debt
   * the in-row settle has to pay. */
  contentTop: number;
  /** When the anchor was captured. A clamp-blocked debt is only worth
   * retaining while the layout that caused it may still be catching up
   * (a virtual row re-measure lands a frame or two after the growth
   * inside it); an old anchor's apparent growth is stale geometry from
   * pages that have since been delivered around the block. */
  capturedAt: number;
}

/**
 * A block anchor locks onto one concrete content block inside a section —
 * a message or activity item, never a container that wraps other anchored
 * blocks. Growth inside the section above that block (an activity trace
 * expanding over the final answer, an image settling) moves the block
 * without moving its row, which the row-keyed anchor cannot express; and
 * the two restores that could see the block do not run for it — the DOM
 * reading anchor is discarded before activity interactions and unused in
 * virtual mode. The block's content position, settled at the scroll idle
 * point against credits from the other layers, is the faithful landmark.
 */
function isBlockLeaf(node: HTMLElement): boolean {
  return !node.querySelector('[data-scroll-anchor]');
}

function lastVisibleBlockIn(child: HTMLElement, top: number, bottom: number): HTMLElement | null {
  let found: HTMLElement | null = null;
  if (child.dataset.scrollAnchor && isBlockLeaf(child)) {
    const rect = child.getBoundingClientRect();
    if (rect.bottom > top + 1 && rect.top < bottom) found = child;
  }
  const nodes = child.querySelectorAll<HTMLElement>('[data-scroll-anchor]');
  // Search positions like firstVisibleAnchor, but never climb to an
  // enclosing anchor: containers are exactly what must not be picked.
  let low = 0, high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (nodes[middle]!.getBoundingClientRect().top <= top + 1) low = middle + 1;
    else high = middle;
  }
  for (let index = Math.max(0, low - 1); index < nodes.length; index++) {
    const node = nodes[index]!;
    const rect = node.getBoundingClientRect();
    if (rect.top >= bottom) break;
    if (rect.bottom > top + 1 && isBlockLeaf(node)) found = node;
  }
  return found;
}

/**
 * The anchored block is the LAST leaf block intersecting the viewport.
 * Reading flows downward: the block at the lower eye line — a turn's
 * final answer sitting mid-viewport — is what growth inside its own
 * section pushes away, while a block at the top may sit above the growth
 * and legitimately never move. Growth above the whole viewport shifts
 * every visible block equally, so the choice only matters for in-row
 * growth, which is the case this anchor exists for.
 */
export function captureBlockAnchor(stream: HTMLElement, inner: HTMLElement): BlockAnchor | null {
  const viewport = stream.getBoundingClientRect();
  let low = 0;
  let high = inner.children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (inner.children[middle]!.getBoundingClientRect().bottom <= viewport.top + 1) low = middle + 1;
    else high = middle;
  }
  let node: HTMLElement | null = null;
  for (let index = low; index < inner.children.length; index++) {
    const child = inner.children[index]!;
    if (child.getBoundingClientRect().top >= viewport.bottom) break;
    if (!(child instanceof HTMLElement)) continue;
    node = lastVisibleBlockIn(child, viewport.top, viewport.bottom) ?? node;
  }
  return node ? { key: node.dataset.scrollAnchor!, node,
    contentTop: node.getBoundingClientRect().top - viewport.top + stream.scrollTop,
    capturedAt: performance.now() } : null;
}

/** How long a clamp-blocked debt stays payable, in milliseconds. The
 * virtual list's total height catches up with growth inside a row within
 * a frame or two of the growth itself; anything older is stale. */
export const BLOCK_DEBT_FRESH_MS = 1500;

/**
 * Pay what is still owed on a block anchor: the block's content top moved
 * by layout growth above it, minus the compensation other layers already
 * wrote since capture (`compensated`, credited synchronously at their
 * write sites). The reader's own scrolling moves neither term, so it is
 * never "compensated" away; row-level restores move the second, so they
 * are never paid twice.
 *
 * `blocked` reports a debt that could not be paid because the target sits
 * more than a rounding step past the scrollable maximum — writing it
 * would be clamped to the end of the window and teleport the reader. A
 * fresh block keeps its baseline and its credits so the next resize can
 * retry once the total height catches up; a stale one is forgiven
 * (re-baselined) and left standing as measured drift.
 */
export function settleBlockAnchor(stream: HTMLElement, inner: HTMLElement,
  anchor: BlockAnchor, compensated: number): { applied: number; blocked: boolean } {
  const node = inner.contains(anchor.node) ? anchor.node
    : [...inner.querySelectorAll<HTMLElement>('[data-scroll-anchor]')].find(node => node.dataset.scrollAnchor === anchor.key);
  if (!node) return { applied: 0, blocked: false };
  anchor.node = node;
  const contentTop = node.getBoundingClientRect().top - stream.getBoundingClientRect().top + stream.scrollTop;
  const owed = (contentTop - anchor.contentTop) - compensated;
  if (Math.abs(owed) <= .5) {
    anchor.contentTop = contentTop;
    return { applied: 0, blocked: false };
  }
  const target = Math.round(stream.scrollTop + owed);
  const maximum = Math.max(0, stream.scrollHeight - stream.clientHeight);
  if (target - maximum > 1) {
    if (performance.now() - anchor.capturedAt <= BLOCK_DEBT_FRESH_MS) return { applied: 0, blocked: true };
    anchor.contentTop = contentTop;
    return { applied: 0, blocked: false };
  }
  anchor.contentTop = contentTop;
  const before = stream.scrollTop;
  stream.scrollTop = Math.min(target, maximum);
  return { applied: stream.scrollTop - before, blocked: false };
}

export function restoreReadingAnchor(stream: HTMLElement, inner: HTMLElement, anchor: ReadingAnchor): boolean {
  const node = inner.contains(anchor.node) ? anchor.node
    : [...inner.querySelectorAll<HTMLElement>('[data-scroll-anchor]')].find(node => node.dataset.scrollAnchor === anchor.key);
  if (!node) return false;
  anchor.node = node;
  // Account for a touch/compositor scroll whose scroll event has not arrived yet.
  const offset = anchor.offset - (stream.scrollTop - anchor.scrollTop);
  const delta = node.getBoundingClientRect().top - stream.getBoundingClientRect().top - offset;
  anchor.offset = offset;
  anchor.scrollTop = stream.scrollTop;
  if (Math.abs(delta) <= .5) return false;
  // WebKit can truncate an almost-integer target and expose a second correction.
  const target = Math.round(stream.scrollTop + delta);
  const missingSpace = target - (stream.scrollHeight - stream.clientHeight);
  // A short initial page has blank space below it. Keep that space while
  // prepending, otherwise the browser clamps the requested reading position.
  if (missingSpace > .5) {
    const tail = parseFloat(inner.style.getPropertyValue('--reading-tail')) || 0;
    inner.style.setProperty('--reading-tail', `${tail + missingSpace}px`);
  }
  stream.scrollTop = target;
  anchor.scrollTop = stream.scrollTop;
  return true;
}
