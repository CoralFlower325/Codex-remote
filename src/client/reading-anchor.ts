export interface ReadingAnchor {
  key: string;
  node: HTMLElement;
  offset: number;
  scrollTop: number;
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
    const node = [...child.querySelectorAll<HTMLElement>('[data-scroll-anchor]')].find(visible)
      ?? (child.dataset.scrollAnchor ? child : null);
    if (node) return { key: node.dataset.scrollAnchor!, node, offset: node.getBoundingClientRect().top - viewport.top,
      scrollTop: stream.scrollTop };
  }
  return null;
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
