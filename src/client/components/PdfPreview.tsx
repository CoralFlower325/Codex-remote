import { ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { copyText } from '../clipboard';
import { previewPixelRatio } from '../preview-rendering';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfReading { page: number; zoom: string; top: number; left: number }

export default function PdfPreview({ url, name, office = false, view }: {
  url: string; name: string; office?: boolean; view?: RefObject<PdfReading>
}) {
  const ownReading = useRef<PdfReading>({ page: 1, zoom: 'fit', top: 0, left: 0 });
  const reading = view ?? ownReading;
  const [requestedUrl, setRequestedUrl] = useState(url);
  const latestUrl = useRef(url);
  latestUrl.current = url;
  const fetching = useRef(false);
  useEffect(() => {
    if (!office || !fetching.current) setRequestedUrl(url);
  }, [url, office]);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(reading.current.page);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(reading.current.zoom);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef('');
  const rendered = useRef(false);
  const sequence = useRef(0);
  const documents = useRef(new Map<PDFDocumentProxy, { task: ReturnType<typeof getDocument>; sequence: number }>());
  useEffect(() => () => {
    for (const { task } of documents.current.values()) void task.destroy();
    documents.current.clear();
  }, []);
  useEffect(() => {
    reading.current.page = page; reading.current.zoom = zoom;
  }, [page, zoom, reading]);
  useEffect(() => {
    let cancelled = false;
    let accepted = false;
    const controller = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    fetching.current = true;
    setError(''); setBusy(true);
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
        const response = await fetch(requestedUrl, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `文档预览失败 (${response.status})`);
        }
        data = new Uint8Array(await response.arrayBuffer());
      }
      if (cancelled) return;
      task = getDocument(data ? { data, useSystemFonts: true } : { url: requestedUrl, withCredentials: true, useSystemFonts: true });
      const result = await task.promise;
      if (!cancelled && !controller.signal.aborted) {
        accepted = true;
        documents.current.set(result, { task, sequence: ++sequence.current });
        setPage(value => Math.min(value, result.numPages));
        setDocument(result);
      }
    })().catch(reason => {
      if (!cancelled && !controller.signal.aborted) { setError(reason.message); setBusy(false); }
    }).finally(() => {
      clearTimeout(timer);
      if (!cancelled) {
        fetching.current = false;
        if (latestUrl.current !== requestedUrl) setRequestedUrl(latestUrl.current);
      }
    });
    return () => { cancelled = true; controller.abort(); if (!accepted) void task?.destroy(); };
  }, [requestedUrl, office]);
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
      const canvas = window.document.createElement('canvas');
      const ratio = previewPixelRatio(viewport.width, viewport.height, window.devicePixelRatio);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      render = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (cancelled || !canvasRef.current) return;
      const visible = canvasRef.current;
      visible.width = canvas.width; visible.height = canvas.height;
      visible.style.width = canvas.style.width; visible.style.height = canvas.style.height;
      visible.getContext('2d')!.drawImage(canvas, 0, 0);
      rendered.current = true;
      const scroller = viewportRef.current;
      if (scroller) { scroller.scrollTop = reading.current.top; scroller.scrollLeft = reading.current.left; }
      const renderedSequence = documents.current.get(document)?.sequence ?? 0;
      for (const [pdf, entry] of documents.current) {
        if (entry.sequence < renderedSequence) { documents.current.delete(pdf); void entry.task.destroy(); }
      }
      setBusy(false);
      const text = await pdfPage.getTextContent();
      if (!cancelled) textRef.current = text.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ');
    })().catch(reason => { if (!cancelled) { setError(reason.message); setBusy(false); } });
    return () => { cancelled = true; render?.cancel(); };
  }, [document, page, width, zoom, reading]);
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
    <div className="pdf-viewport" ref={viewportRef} aria-busy={busy} onScroll={event => {
      reading.current.top = event.currentTarget.scrollTop; reading.current.left = event.currentTarget.scrollLeft;
    }}>
      {busy && !rendered.current && <div className="pdf-loading" role="status">{office ? '正在生成文档预览…' : '正在加载 PDF'}</div>}
      <canvas ref={canvasRef} role="img" aria-label={`${name} · ${page}`} data-rendered={!busy && !error} />
    </div>
  </div>;
}
