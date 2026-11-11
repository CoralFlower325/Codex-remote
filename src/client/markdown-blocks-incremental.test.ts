import { describe, expect, it } from 'vitest';
import { createMarkdownBlocksCache, markdownBlocks } from './markdown-blocks';

/**
 * Equivalence harness: stream each document in pieces through one cache
 * and compare every intermediate result against a from-scratch full
 * parse of the same text. Any divergence — offsets included — fails.
 */
function expectStreamEquivalent(full: string, chunks: string[]) {
  const cache = createMarkdownBlocksCache();
  let text = '';
  for (const chunk of chunks) {
    text += chunk;
    expect(markdownBlocks(text, cache)).toEqual(markdownBlocks(text));
  }
  expect(text).toBe(full);
}

const byLines = (text: string) => text.split(/(?<=\n)/).filter(Boolean);
const byChars = (text: string, size: number) => {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
};

describe('incremental markdown blocks equivalence', () => {
  it('matches the full parse for a long streamed answer with a code fence', () => {
    const paragraphs = Array.from({ length: 26 }, (_, i) => `流式段落 ${i}：这是正在生成的长答复的一部分，内容保持稳定，不再变化。`);
    const code = Array.from({ length: 60 }, (_, i) => `  step${i}: run check ${i} -> ok`).join('\n');
    const full = `${paragraphs.join('\n\n')}\n\n\`\`\`ts\n${code}\n\`\`\`\n\n流式结束标记 STREAM-END`;
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles a link definition that only arrives at the end', () => {
    const full = 'See [link][id] for details.\n\nA second paragraph uses [link][id] too.\n\n[id]: https://example.com';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles a link definition declared before its uses', () => {
    const full = '[id]: https://example.com\n\nSee [link][id] for details.\n\nMore text follows here.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('collapses to a single block when a footnote definition arrives in the tail', () => {
    const full = 'First[^a].\n\nSecond[^b].\n\n[^a]: One\n\n[^b]: Two';
    expectStreamEquivalent(full, byLines(full));
  });

  it('stays a single block when the footnote definition is already in the prefix', () => {
    const full = '[^a]: One\n\nFirst[^a] paragraph.\n\nSecond paragraph keeps growing here.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles an unclosed fence that closes later, then keeps growing', () => {
    const full = 'Before code.\n\n```js\none\n\ntwo\n```\n\nAfter code, a closing paragraph.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles setext headings and thematic breaks', () => {
    const full = 'A paragraph.\n\nHeading\n=======\n\nAnother paragraph.\n\n---\n\nTail paragraph.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles tables built row by row', () => {
    const full = 'Intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nOutro paragraph.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles nested and loose lists', () => {
    const full = '- parent\n  - child\n  - second child\n\n- loose item\n\n- another loose item\n\nClosing paragraph.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles blockquotes spanning several lines', () => {
    const full = '> quoted line one\n> quoted line two\n>\n> second quoted paragraph\n\nPlain paragraph after.';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles math that closes inside the same block', () => {
    const full = '前文 \\(x+1\\) 后文继续。\n\n第二段有 $$E = mc^2$$ 公式。\n\n尾段。';
    expectStreamEquivalent(full, byLines(full));
  });

  it('handles an unclosed \\[ whose closer rewrites the prefix when it arrives', () => {
    const full = '推导如下 \\[ x^2 + y^2 = z^2 \\] 完成。\n\n后续段落继续增长。';
    expectStreamEquivalent(full, byChars(full, 7));
  });

  it('handles display math blocks', () => {
    const full = '公式：\n\n$$\nE = mc^2\n$$\n\n结束段落。';
    expectStreamEquivalent(full, byLines(full));
  });

  it('stays equivalent when the text is edited in place instead of appended', () => {
    const cache = createMarkdownBlocksCache();
    const before = 'First paragraph stays.\n\nSecond paragraph will change.\n\nThird.';
    expect(markdownBlocks(before, cache)).toEqual(markdownBlocks(before));
    const after = 'First paragraph stays.\n\nSecond paragraph DID change.\n\nThird.';
    expect(markdownBlocks(after, cache)).toEqual(markdownBlocks(after));
    const shrunk = 'First paragraph stays.';
    expect(markdownBlocks(shrunk, cache)).toEqual(markdownBlocks(shrunk));
  });

  it('reuses stable block objects while the tail grows', () => {
    const cache = createMarkdownBlocksCache();
    const before = markdownBlocks('First paragraph.\n\nStill stream', cache);
    const after = markdownBlocks('First paragraph.\n\nStill streaming.', cache);
    expect(after[0]).toBe(before[0]);
    expect(after[1]!.text).toBe('Still streaming.');
  });

  it('keeps per-cache isolation between two documents', () => {
    const cacheA = createMarkdownBlocksCache();
    const cacheB = createMarkdownBlocksCache();
    const a1 = markdownBlocks('Document A first.\n\nA tail', cacheA);
    const b1 = markdownBlocks('Document B first.\n\nB tail', cacheB);
    const a2 = markdownBlocks('Document A first.\n\nA tail grows.', cacheA);
    const b2 = markdownBlocks('Document B first.\n\nB tail grows.', cacheB);
    expect(a2[0]).toBe(a1[0]);
    expect(b2[0]).toBe(b1[0]);
    expect(a2).toEqual(markdownBlocks('Document A first.\n\nA tail grows.'));
    expect(b2).toEqual(markdownBlocks('Document B first.\n\nB tail grows.'));
  });
});
