import { ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { copyText } from '../clipboard';
import { previewPixelRatio } from '../preview-rendering';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ url, name, office = false }: { url: string; name: string; office?: boolean }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState('fit');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef('');
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    setDocument(null); setPage(1); setError(''); setBusy(true); textRef.current = '';
    const timer = window.setTimeout(() => {
      controller.abort();
      void task?.destroy();
      if (!cancelled) { setError('文档加载超时，请刷新预览或下载原文件。'); setBusy(false); }
    }, office ? 150_000 : 15_000);
    void (async () => {
      // Office errors are JSON; fetch before PDF.js so a missing converter or
      // encrypted document produces the actual actionable server message.
      let data: Uint8Array<ArrayBuffer> | undefined;
      if (office) {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `文档预览失败 (${response.status})`);
        }
        data = new Uint8Array(await response.arrayBuffer());
      }
      if (cancelled) return;
      task = getDocument(data ? { data, useSystemFonts: true } : { url, withCredentials: true, useSystemFonts: true });
      const result = await task.promise;
      if (!cancelled) setDocument(result);
    })().catch(reason => {
      if (!cancelled && !controller.signal.aborted) { setError(reason.message); setBusy(false); }
    }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); void task?.destroy(); };
  }, [url, office]);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !width) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setBusy(true); setError('');
    textRef.current = '';
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled || !canvasRef.current) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const scale = zoom === 'fit' ? Math.max(.1, (width - 24) / natural.width) : Number(zoom);
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const ratio = previewPixelRatio(viewport.width, viewport.height, window.devicePixelRatio);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      render = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (cancelled) return;
      setBusy(false);
      const text = await pdfPage.getTextContent();
      if (!cancelled) textRef.current = text.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ');
    })().catch(reason => { if (!cancelled) { setError(reason.message); setBusy(false); } });
    return () => { cancelled = true; render?.cancel(); };
  }, [document, page, width, zoom]);
  return <div className="pdf-preview">
    <div className="pdf-toolbar">
      <button type="button" className="icon-button" title="上一页" aria-label="上一页"
        disabled={!document || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button>
      <input aria-label="PDF 页码" type="number" min={1} max={document?.numPages ?? 1} value={page}
        onChange={event => setPage(Math.max(1, Math.min(document?.numPages ?? 1, Number(event.target.value) || 1)))} />
      <span>/ {document?.numPages ?? '…'}</span>
      <button type="button" className="icon-button" title="下一页" aria-label="下一页"
        disabled={!document || page >= document.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button>
      <select aria-label="PDF 缩放" value={zoom} onChange={event => setZoom(event.target.value)}>
        <option value="fit">适合宽度</option><option value="1">100%</option>
        <option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option>
      </select>
      <button type="button" className="icon-button" title="复制本页文字" aria-label="复制本页文字" disabled={busy}
        onClick={() => { void copyText(textRef.current).catch(reason => setError(reason.message)); }}><Copy size={15} /></button>
    </div>
    {error && <div role="alert" className="file-preview-error">{error}</div>}
    <div className="pdf-viewport" ref={viewportRef} aria-busy={busy}>
      {busy && <div className="pdf-loading" role="status">{office ? '正在生成文档预览…' : '正在加载 PDF'}</div>}
      <canvas ref={canvasRef} role="img" aria-label={`${name} · ${page}`} data-rendered={!busy && !error} />
    </div>
  </div>;
}
