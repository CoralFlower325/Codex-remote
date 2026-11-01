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

export function markdownBlocks(text: string): Array<{ offset: number; text: string }> {
  text = normalizeMathDelimiters(text);
  const tree = parser.parse(text);
  // Footnote numbering and backreferences span the whole document.
  if (tree.children.some(node => node.type === 'footnoteDefinition')) return [{ offset: 0, text }];
  const definitions = tree.children.filter(node => node.type === 'definition' || node.type === 'footnoteDefinition')
    .map(node => text.slice(node.position!.start.offset, node.position!.end.offset)).join('\n\n');
  return tree.children.filter(node => node.type !== 'definition' && node.type !== 'footnoteDefinition').map(node => ({
    offset: node.position!.start.offset!,
    text: text.slice(node.position!.start.offset, node.position!.end.offset) +
      (definitions ? `\n\n${definitions}` : '')
  }));
}
