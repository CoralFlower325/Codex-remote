import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes, Root } from 'mdast';
import { previewLabel, previewTarget } from './preview-links';
import { normalizeMathDelimiters } from './markdown-math';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function remarkAssistantSources() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const linked = assistantFileLinks(source, tree);
    if (linked !== source) {
      tree = parser.parse(linked);
      file.value = linked;
    }
    const visit = (node: Nodes): void => {
      if (node.type === 'text') {
        node.value = node.value.replace(/\uE200(?:cite|filecite)\uE202[^\uE200\uE201\r\n]*(?:\uE201|$)/g, '');
      }
      if ('children' in node) node.children.forEach(visit);
      if (node.type === 'link' && node.children.every(child => child.type === 'text' && !child.value.trim())) {
        node.children = [{ type: 'text', value: node.url }];
      }
    };
    visit(tree);
    return tree;
  };
}

function assistantFileLinks(source: string, tree: Root): string {
  if (!source.includes('codex-file-citation{')) return source;
  const protectedRanges: Array<[number, number]> = [];
  const protect = (node: Nodes): void => {
    if (['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html'].includes(node.type)) {
      if (node.position) protectedRanges.push([node.position.start.offset!, node.position.end.offset!]);
    } else if ('children' in node) node.children.forEach(protect);
  };
  protect(tree);
  let range = 0;
  return source.replace(/(?<![\w-]):{0,2}codex-file-citation\{([^{}\r\n]*)\}/g, (literal, body: string, offset: number) => {
    while (protectedRanges[range] && protectedRanges[range]![1] <= offset) range++;
    if (protectedRanges[range] && protectedRanges[range]![0] < offset + literal.length) return literal;
    const attributes = new Map<string, string>();
    const attribute = /\s*([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let cursor = 0;
    while (cursor < body.length && body.slice(cursor).trim()) {
      attribute.lastIndex = cursor;
      const match = attribute.exec(body);
      if (!match || attributes.has(match[1]!)) return literal;
      attributes.set(match[1]!, match[2] ?? match[3]!);
      cursor = attribute.lastIndex;
    }
    const path = attributes.get('path');
    if (!path || /[\u0000-\u001f]/.test(path)) return literal;
    const target = previewTarget(path, '/workspace');
    if (target?.kind !== 'file') return literal;
    const value = /^file:\/\//i.test(path)
      ? target.path + (target.line ? `:${target.line}` : '') : path.replace(/\\/g, '/');
    const href = encodeURIComponent(value).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
    const label = (previewLabel(target) + (target.line ? `:${target.line}` : '')).replace(/[\\`*_[\]<>]/g, '\\$&');
    return `[${label}](<${href}>)`;
  });
}

export interface MarkdownBlock {
  offset: number;
  text: string;
}

interface MarkdownChildSpan {
  start: number;
  end: number;
  definition: boolean;
}

interface ParsedMarkdownDocument {
  /** The normalized source this parse belongs to. */
  source: string;
  /** Top-level node spans in document order (definitions included). */
  children: MarkdownChildSpan[];
  /** Definition source slices in document order. */
  definitions: string[];
  /** A footnote definition anywhere collapses the document to one block. */
  footnote: boolean;
  blocks: MarkdownBlock[];
}

function renderBlocks(source: string, children: MarkdownChildSpan[], definitions: string[]): MarkdownBlock[] {
  const suffix = definitions.length ? `\n\n${definitions.join('\n\n')}` : '';
  return children.filter(child => !child.definition).map(child => ({
    offset: child.start,
    text: source.slice(child.start, child.end) + suffix
  }));
}

function parseMarkdownDocument(source: string): ParsedMarkdownDocument {
  const tree = parser.parse(source);
  const children: MarkdownChildSpan[] = tree.children.map(node => ({
    start: node.position!.start.offset!,
    end: node.position!.end.offset!,
    definition: node.type === 'definition' || node.type === 'footnoteDefinition'
  }));
  const definitions = tree.children
    .filter(node => node.type === 'definition' || node.type === 'footnoteDefinition')
    .map(node => source.slice(node.position!.start.offset, node.position!.end.offset));
  // Footnote numbering and backreferences span the whole document.
  const footnote = tree.children.some(node => node.type === 'footnoteDefinition');
  return {
    source, children, definitions, footnote,
    blocks: footnote ? [{ offset: 0, text: source }] : renderBlocks(source, children, definitions)
  };
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
  return index;
}

/**
 * Caller-owned incremental parse state for one growing document. The
 * owner (MarkdownText) keeps one cache per rendered message in a ref;
 * there is deliberately no module-level cache, so unrelated documents
 * can never pollute each other.
 */
export interface MarkdownBlocksCache {
  document: ParsedMarkdownDocument | null;
}

export function createMarkdownBlocksCache(): MarkdownBlocksCache {
  return { document: null };
}

/**
 * Split a document into top-level blocks. Without a cache this is the
 * full parse. With a cache, a document that only grew reuses the stable
 * prefix: only the tail starting at the previous document's last
 * top-level node is re-parsed. Three document-wide channels can rewrite
 * the prefix after the fact and are guarded explicitly:
 *
 * - Link definitions are appended to every block, so any change to the
 *   definition set invalidates the cached blocks (full re-parse).
 * - A footnote definition anywhere collapses the document into a single
 *   block, whether it was already in the prefix or arrives in the tail.
 * - Math delimiter normalization is not prefix-stable (an unclosed \[
 *   is rewritten once its closer arrives), so the cache key is the
 *   normalized text and the longest common prefix of the old and new
 *   normalized texts bounds how much of the prefix may be trusted; the
 *   re-parse always restarts at or before that point, at a node start.
 */
export function markdownBlocks(text: string, cache?: MarkdownBlocksCache): MarkdownBlock[] {
  const source = normalizeMathDelimiters(text);
  const previous = cache?.document;
  if (!cache || !previous || previous.footnote || previous.children.length === 0) {
    const document = parseMarkdownDocument(source);
    if (cache) cache.document = document;
    return document.blocks;
  }
  if (source === previous.source) return previous.blocks;
  const prefix = commonPrefixLength(previous.source, source);
  // The last node whose start is not past the trusted prefix: re-parsing
  // restarts at its start, so a change inside it — or in the whitespace
  // right after it — can never leave a stale boundary behind.
  let restartIndex = 0;
  for (let index = 0; index < previous.children.length; index++) {
    if (previous.children[index]!.start <= prefix) restartIndex = index;
    else break;
  }
  const restart = previous.children[restartIndex]!.start;
  const stable = previous.children.slice(0, restartIndex);
  const tail = parseMarkdownDocument(source.slice(restart));
  if (tail.footnote) {
    const document = parseMarkdownDocument(source);
    cache.document = document;
    return document.blocks;
  }
  const stableDefinitions = stable.filter(child => child.definition)
    .map(child => previous.source.slice(child.start, child.end));
  const definitions = [...stableDefinitions, ...tail.definitions];
  const definitionsChanged = definitions.length !== previous.definitions.length ||
    definitions.some((definition, index) => definition !== previous.definitions[index]);
  if (definitionsChanged) {
    const document = parseMarkdownDocument(source);
    cache.document = document;
    return document.blocks;
  }
  const children = [...stable, ...tail.children.map(child => ({
    start: child.start + restart, end: child.end + restart, definition: child.definition
  }))];
  const stableBlockCount = stable.filter(child => !child.definition).length;
  const tailBlocks = renderBlocks(source, children.slice(stable.length), definitions);
  const blocks = [...previous.blocks.slice(0, stableBlockCount), ...tailBlocks];
  cache.document = { source, children, definitions, footnote: false, blocks };
  return blocks;
}
