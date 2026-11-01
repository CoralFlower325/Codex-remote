import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes, Parent, Root } from 'mdast';

const plainParser = unified().use(remarkParse).use(remarkGfm);
const protectedTypes = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html']);

// CommonMark consumes these backslashes before remark transforms can see them.
export function normalizeMathDelimiters(text: string): string {
  if (!/\\[([]/.test(text)) return text;
  const ranges: Array<[number, number]> = [];
  const protect = (node: Nodes): void => {
    const bareLink = node.type === 'link' && node.position &&
      !/^[<[!]/.test(text.slice(node.position.start.offset, node.position.end.offset));
    if (protectedTypes.has(node.type) && !bareLink) {
      if (node.position) ranges.push([node.position.start.offset!, node.position.end.offset!]);
    } else if ('children' in node) node.children.forEach(protect);
  };
  protect(plainParser.parse(text));
  let cursor = 0;
  let output = '';
  const unescaped = (offset: number): boolean => {
    let backslashes = 0;
    while (text[offset - backslashes - 1] === '\\') backslashes++;
    return backslashes % 2 === 0;
  };
  const openings = /\\([([])/g;
  let range = 0;
  for (const match of text.matchAll(openings)) {
    const start = match.index;
    if (start < cursor || !unescaped(start)) continue;
    while (ranges[range] && ranges[range]![1] <= start) range++;
    if (ranges[range] && ranges[range]![0] <= start) continue;
    const display = match[1] === '[';
    const closing = display ? '\\]' : '\\)';
    let end = text.indexOf(closing, start + 2);
    while (end >= 0 && !unescaped(end)) end = text.indexOf(closing, end + 2);
    if (end < 0 || (ranges[range] && ranges[range]![0] < end + 2)) continue;
    const value = text.slice(start + 2, end);
    if (!value.trim() || (!display && /[\r\n]/.test(value))) continue;
    const standalone = display && !/[\r\n]/.test(value) &&
      !text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() &&
      !text.slice(end + 2, text.indexOf('\n', end + 2) < 0 ? text.length : text.indexOf('\n', end + 2)).trim();
    const delimiter = display ? (standalone ? '$$\n' : '$$') : '$';
    const suffix = display ? (standalone ? '\n$$' : '$$') : '$';
    output += text.slice(cursor, start) + delimiter + (display ? value : value.trim()) + suffix;
    cursor = end + 2;
  }
  return cursor ? output + text.slice(cursor) : text;
}

export function remarkMathText() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: Parent, literal = false): void => {
      parent.children = parent.children.map(node => {
        const protectedText = literal || protectedTypes.has(node.type);
        if (node.type === 'inlineMath' || node.type === 'math') {
          const raw = source.slice(node.position!.start.offset, node.position!.end.offset);
          const firstBreak = raw.indexOf('\n');
          const fenceLength = /^[ \t]*(\${2,})/.exec(raw)?.[1]?.length ?? 2;
          const lastLine = raw.slice(raw.lastIndexOf('\n') + 1).replace(/^[ \t]*(?:>[ \t]*)*/, '').trim();
          const unclosed = node.type === 'math' && (firstBreak < 0 ||
            !/^\$+$/.test(lastLine) || lastLine.length < fenceLength);
          const currency = node.type === 'inlineMath' && !raw.startsWith('$$') &&
            (/^\$\s|\s\$$/.test(raw) || (/^\$\d/.test(raw) && /^\d/.test(source.slice(node.position!.end.offset))));
          if (protectedText || unclosed || currency) {
            const text: Nodes = { type: 'text', value: raw };
            return node.type === 'math' ? { type: 'paragraph' as const, children: [text] } : text;
          }
          if (node.type === 'inlineMath' && raw.startsWith('$$') && node.data) {
            node.data.hProperties = { className: ['language-math', 'math-display'] };
          }
        }
        if ('children' in node) visit(node, protectedText);
        return node;
      }) as typeof parent.children;
    };
    visit(tree);
  };
}
