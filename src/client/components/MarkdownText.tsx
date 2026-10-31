import { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localImageSource } from '../markdown-media';
import { markdownBlocks, remarkAssistantSources } from '../markdown-blocks';
import { PreviewImage, PreviewLink } from './PreviewLinks';

export const MarkdownText = memo(function MarkdownText({ text, assistant = false }: { text: string; assistant?: boolean }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return <>{blocks.map(block => <MarkdownBlock key={block.offset} text={block.text} assistant={assistant} />)}</>;
});

const MarkdownBlock = memo(function MarkdownBlock({ text, assistant }: { text: string; assistant: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={assistant ? [remarkGfm, remarkAssistantSources] : [remarkGfm]}
      urlTransform={(url) =>
        /^(?:file:\/\/|[a-z]:[\\/])/i.test(url) || localImageSource(url).startsWith('/api/local-image?') ? url : defaultUrlTransform(url)
      }
      components={{
        a: PreviewLink,
        img: ({ src, alt }) => (
          <PreviewImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />
        )
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

