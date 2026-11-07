import { ArrowUpRight, Check, Copy, Download, RefreshCw, WrapText } from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import type { PreviewTarget } from '../../shared/file-preview';
import { previewVersionUrl } from '../../shared/file-preview';
import { copyText } from '../clipboard';
import { previewLabel } from '../preview-links';
import { MarkdownText } from './MarkdownText';
import { PreviewLinks } from './PreviewLinks';
import { useFilePreview } from '../useFilePreview';
import { PathText, CopyPathButton } from './PathText';
import type { PdfReading } from './PdfPreview';

const PdfPreview = lazy(() => import('./PdfPreview'));

export default function FilePreview({ target, active, request = 0 }: {
  target: PreviewTarget; active: boolean; request?: number
}) {
  const [actionError, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const htmlRef = useRef<HTMLIFrameElement>(null);
  const htmlReading = useRef({ top: 0, left: 0 });
  const pdfReading = useRef<PdfReading>({ page: 1, zoom: 'fit', top: 0, left: 0 });
  const path = target.kind === 'file' ? target.path : '';
  const { file, html, error: readError, loading } = useFilePreview(path, active, `${request}:${revision}`);
  const error = actionError || readError;
  const targetKey = target.kind === 'file' ? `file:${target.path}:${target.line ?? ''}` : `url:${target.url}`;
  const reading = useRef({ top: 0, left: 0, following: false });
  const navigated = useRef('');
  useEffect(() => {
    setSource(false); setError('');
    navigated.current = '';
  }, [targetKey]);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    node.scrollTop = reading.current.following ? node.scrollHeight : reading.current.top;
    node.scrollLeft = reading.current.left;
  }, [file, active]);
  const line = target.kind === 'file' ? target.line : undefined;
  const loaded = Boolean(file);
  const navigationKey = `${targetKey}:${request}`;
  useEffect(() => {
    if (!active || file?.kind !== 'html') return;
    const remember = (event: MessageEvent) => {
      if (event.source !== htmlRef.current?.contentWindow || event.data?.type !== 'preview-scroll') return;
      const { top, left } = event.data;
      if (Number.isFinite(top) && Number.isFinite(left)) htmlReading.current = { top, left };
    };
    window.addEventListener('message', remember);
    return () => window.removeEventListener('message', remember);
  }, [active, file?.kind]);
  useEffect(() => {
    if (!active || !line || !loaded || navigated.current === navigationKey) return;
    navigated.current = navigationKey;
    setSource(true);
    const frame = requestAnimationFrame(() => {
      const node = bodyRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
      node?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, line, loaded, navigationKey]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const href = target.kind === 'url' ? target.url : file?.contentUrl;
  const rich = file?.kind === 'markdown' || file?.kind === 'html';
  const text = file?.text;
  return <div className="file-preview">
    <div className="file-preview-toolbar">
      {rich ? <div className="file-preview-modes" role="group" aria-label="文件视图">
        <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>预览</button>
        <button type="button" aria-pressed={source} onClick={() => setSource(true)}>源码</button>
      </div> : <span className="file-preview-name" title={target.kind === 'file' ? target.path : target.url}>{previewLabel(target)}</span>}
      <div className="file-preview-tools">
        {text !== undefined && <>
          <button type="button" className="icon-button" aria-label="自动换行" title="自动换行"
            aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={15} /></button>
          <button type="button" className="icon-button" aria-label={copied ? '已复制' : '复制文件内容'} title="复制文件内容"
            onClick={() => { void copyText(text).then(() => setCopied(true)).catch(reason => setError(reason.message)); }}>
            {copied ? <Check size={15} /> : <Copy size={15} />}</button>
        </>}
        <button type="button" className="icon-button" aria-label="刷新预览" title="刷新预览"
          onClick={() => { setError(''); setRevision(value => value + 1); }}><RefreshCw size={15} /></button>
        {href && <>
          {target.kind === 'file' && <a className="icon-button" href={href} download={file?.name} aria-label="下载文件" title="下载文件"><Download size={15} /></a>}
          <a className="icon-button" href={href} target="_blank" rel="noreferrer" aria-label="在新标签页打开" title="在新标签页打开"><ArrowUpRight size={15} /></a>
        </>}
      </div>
    </div>
    {target.kind === 'file' && <div className="file-preview-path"><PathText value={file?.path || target.path} />
      <CopyPathButton value={file?.path || target.path} /></div>}
    {error && <div className="file-preview-error" role="alert">{error}</div>}
    {!active ? null : loading ? <div className="file-preview-loading" role="status" aria-label="正在加载预览">
      <div className="message-skeleton message-skeleton--long" /><div className="message-skeleton message-skeleton--medium" />
    </div> : <div className={`file-preview-body${wrap ? ' file-preview--wrap' : ''}`} ref={bodyRef}
      onScroll={event => {
        const node = event.currentTarget;
        reading.current = { top: node.scrollTop, left: node.scrollLeft,
          following: node.scrollHeight > node.clientHeight && node.scrollHeight - node.clientHeight - node.scrollTop < 8 };
      }}>
      {target.kind === 'url' ? <iframe key={revision} title={previewLabel(target)} src={target.url}
        sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" />
        : file && (source || file.kind === 'text') && text !== undefined ? <SourceText
          name={file.name} text={text} line={target.kind === 'file' ? target.line : undefined} />
        : file?.kind === 'markdown' ? <PreviewLinks cwd={file.path.replace(/[\\/][^\\/]+$/, '')}>
          <div className="file-preview-markdown markdown"><MarkdownText text={text ?? ''} preserveDocument /></div>
        </PreviewLinks>
        : file?.kind === 'html' && html !== null ? <iframe key={`${revision}:${file.revision ?? html}`} ref={htmlRef} title={file.name} srcDoc={html}
          onLoad={() => htmlRef.current?.contentWindow?.postMessage({
            type: 'preview-restore-scroll', ...htmlReading.current
          }, '*')}
          sandbox="allow-scripts" referrerPolicy="no-referrer" />
        : file?.kind === 'pdf' || file?.kind === 'office' ? <Suspense fallback={<div className="file-preview-loading" role="status">正在加载文档</div>}>
          <PdfPreview url={previewVersionUrl(file.kind === 'office' ? file.previewUrl! : file.contentUrl, `${file.revision ?? ''}-${revision}`)} name={file.name}
            office={file.kind === 'office'} view={pdfReading} />
        </Suspense>
        : file?.kind === 'image' ? <div className="file-preview-image">
          {mediaLoading && <span role="status">正在加载图片</span>}
          <img src={previewVersionUrl(file.contentUrl, `${file.revision ?? ''}-${revision}`)} alt={file.name} onLoad={() => setMediaLoading(false)}
            onError={() => { setMediaLoading(false); setError('图片加载失败，请刷新预览'); }} /></div>
        : file?.kind === 'binary' ? <div className="inspector-empty"><Download size={24} />
          <a href={file.contentUrl} download={file.name}>下载 {file.name}</a></div> : null}
    </div>}
    {file?.truncated && <div className="file-preview-notice" role="status">仅预览前 1 MiB，下载可查看完整文件。</div>}
  </div>;
}

function SourceText({ name, text, line }: { name: string; text: string; line: number | undefined }) {
  const lines = useMemo(() => {
    const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
    const language = ({ tsx: 'typescript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      md: 'markdown', html: 'xml', htm: 'xml', vue: 'xml', ps1: 'powershell', sh: 'bash' } as Record<string, string>)[extension] ?? extension;
    const html = text.length < 200_000 && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value
      : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html.split('\n');
  }, [name, text]);
  return <pre className="file-source"><code>{lines.map((html, index) =>
    <span key={index} data-line={index + 1} className={`file-code-line${line === index + 1 ? ' is-selected' : ''}`}>
      <span className="file-line-number" aria-hidden="true">{index + 1}</span>
      <span className="file-line-text" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
    </span>)}</code></pre>;
}
