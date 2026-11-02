import { Component, lazy, memo, Suspense, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { localImageSource } from '../markdown-media';
import { markdownBlocks, remarkAssistantSources } from '../markdown-blocks';
import { normalizeMathDelimiters, remarkMathText } from '../markdown-math';
import { PreviewImage, PreviewLink } from './PreviewLinks';

const MathFormula = lazy(() => import('./MathFormula'));
const regularPlugins = [remarkGfm, remarkMath, remarkMathText];
const assistantPlugins = [remarkGfm, remarkMath, remarkAssistantSources, remarkMathText];

export const MarkdownText = memo(function MarkdownText({ text, assistant = false, preserveDocument = false }: {
  text: string; assistant?: boolean; preserveDocument?: boolean;
}) {
  const blocks = useMemo(() => preserveDocument
    ? [{ offset: 0, text: normalizeMathDelimiters(text) }]
    : markdownBlocks(text), [preserveDocument, text]);
  return <>{blocks.map(block => <MarkdownBlock key={block.offset} text={block.text} assistant={assistant} />)}</>;
});

const MarkdownBlock = memo(function MarkdownBlock({ text, assistant }: { text: string; assistant: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={assistant ? assistantPlugins : regularPlugins}
      urlTransform={(url) =>
        /^(?:file:\/\/|[a-z]:[\\/])/i.test(url) || localImageSource(url).startsWith('/api/local-image?') ? url : defaultUrlTransform(url)
      }
      components={{
        a: PreviewLink,
        pre: ({ node, children }) => node?.children.some(child => child.type === 'element' &&
          Array.isArray(child.properties.className) && child.properties.className.includes('math-display'))
          ? <div className="math-block" tabIndex={0}>{children}</div> : <pre>{children}</pre>,
        code: ({ className, children }) => {
          const display = className?.split(' ').includes('math-display') ?? false;
          if (!display && !className?.split(' ').includes('math-inline')) return <code className={className}>{children}</code>;
          const expression = String(children).replace(/\n$/, '');
          const fallback = <span className="math-literal">{display ? `\\[${expression}\\]` : `\\(${expression}\\)`}</span>;
          return <span className={display ? 'math-expression math-expression--display' : 'math-expression'}>
            <MathBoundary fallback={fallback}><Suspense fallback={fallback}>
              <MathFormula expression={expression} display={display} />
            </Suspense></MathBoundary>
          </span>;
        },
        img: ({ src, alt }) => (
          <PreviewImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />
        )
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

class MathBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

