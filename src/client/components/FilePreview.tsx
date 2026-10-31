import { ArrowUpRight, Check, Copy, Download, RefreshCw, WrapText } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import type { PreviewFile, PreviewTarget } from '../../shared/file-preview';
import { api } from '../api';
import { copyText } from '../clipboard';
import { previewLabel } from '../preview-links';
import { MarkdownText } from './MarkdownText';
import { PreviewLinks } from './PreviewLinks';
import { previewDocument } from '../preview-rendering';

const PdfPreview = lazy(() => import('./PdfPreview'));

export default function FilePreview({ target, active }: { target: PreviewTarget; active: boolean }) {
  const [file, setFile] = useState<PreviewFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const path = target.kind === 'file' ? target.path : '';
  useEffect(() => {
    if (!active) return;
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(''); setFile(null); setHtml(null); setMediaLoading(true);
    void api<PreviewFile>(`/api/file-preview?${new URLSearchParams({ path })}`, {
      cache: 'no-store', signal: controller.signal, timeoutMs: 15_000
    }).then(async result => {
      if (result.kind === 'html' && result.previewUrl) {
        const url = new URL(result.previewUrl, window.location.href).href;
        const content = await api<string>(url, { cache: 'no-store', signal: controller.signal, timeoutMs: 15_000 });
        if (controller.signal.aborted) return;
        setHtml(previewDocument(content, url));
      }
      if (controller.signal.aborted) return;
      setFile(result); setLoading(false);
    })
      .catch(reason => {
        if (!controller.signal.aborted) { setError(reason.message); setLoading(false); }
      });
    return () => controller.abort();
  }, [active, path, revision, target]);
  useEffect(() => {
    if (target.kind !== 'file' || !target.line || !file) return;
    setSource(true);
    const frame = requestAnimationFrame(() => {
      const node = bodyRef.current?.querySelector<HTMLElement>(`[data-line="${target.line}"]`);
      node?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, file]);
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
          onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} /></button>
        {href && <>
          {target.kind === 'file' && <a className="icon-button" href={href} download={file?.name} aria-label="下载文件" title="下载文件"><Download size={15} /></a>}
          <a className="icon-button" href={href} target="_blank" rel="noreferrer" aria-label="在新标签页打开" title="在新标签页打开"><ArrowUpRight size={15} /></a>
        </>}
      </div>
    </div>
    {error && <div className="file-preview-error" role="alert">{error}</div>}
    {!active ? null : loading ? <div className="file-preview-loading" role="status" aria-label="正在加载预览">
      <div className="message-skeleton message-skeleton--long" /><div className="message-skeleton message-skeleton--medium" />
    </div> : <div className={`file-preview-body${wrap ? ' file-preview--wrap' : ''}`} ref={bodyRef}>
      {target.kind === 'url' ? <iframe key={revision} title={previewLabel(target)} src={target.url}
        sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" />
        : file && (source || file.kind === 'text') && text !== undefined ? <SourceText
          name={file.name} text={text} line={target.kind === 'file' ? target.line : undefined} />
        : file?.kind === 'markdown' ? <PreviewLinks cwd={file.path.replace(/[\\/][^\\/]+$/, '')}>
          <div className="file-preview-markdown markdown"><MarkdownText text={text ?? ''} /></div>
        </PreviewLinks>
        : file?.kind === 'html' && html !== null ? <iframe key={revision} title={file.name} srcDoc={html}
          sandbox="allow-scripts" referrerPolicy="no-referrer" />
        : file?.kind === 'pdf' ? <Suspense fallback={<div className="file-preview-loading" role="status">正在加载 PDF</div>}>
          <PdfPreview url={file.contentUrl} name={file.name} />
        </Suspense>
        : file?.kind === 'image' ? <div className="file-preview-image">
          {mediaLoading && <span role="status">正在加载图片</span>}
          <img src={file.contentUrl} alt={file.name} onLoad={() => setMediaLoading(false)}
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
