import { useEffect, useRef, useState } from 'react';
import type { PreviewFile } from '../shared/file-preview';
import { api, HttpError } from './api';
import { previewDocument } from './preview-rendering';

interface PreviewSnapshot { file: PreviewFile; html: string | null }

export function useFilePreview(path: string, active: boolean, refresh: string) {
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState('');
  const [watchError, setWatchError] = useState('');
  const [loading, setLoading] = useState(Boolean(path));
  const current = useRef<PreviewSnapshot | null>(null);
  useEffect(() => {
    current.current = null;
    setSnapshot(null); setError(''); setWatchError(''); setLoading(Boolean(path));
  }, [path]);
  useEffect(() => {
    if (!path || !active) return;
    let disposed = false;
    let stream: EventSource | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false, pending = false, lastRead = 0;
    let renewHtml = true;
    let failures = 0;
    let observed = '';
    const stop = () => {
      stream?.close(); stream = null;
      controller?.abort(); controller = null;
      clearTimeout(timer); timer = undefined;
    };
    const request = () => {
      if (disposed || document.hidden) return;
      pending = true;
      if (busy || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, Math.max(0, (current.current?.file.kind === 'office' ? 2000 : 400) - (Date.now() - lastRead)));
    };
    const read = async () => {
      if (disposed || document.hidden || busy) return;
      pending = false; busy = true; lastRead = Date.now();
      const readController = new AbortController();
      controller = readController;
      try {
        const file = await api<PreviewFile>(`/api/file-preview?${new URLSearchParams({ path })}`, {
          cache: 'no-store', signal: readController.signal, timeoutMs: 15_000
        });
        let html: string | null = null;
        const unchanged = file.revision && current.current?.file.revision === file.revision;
        if (unchanged && !renewHtml && file.kind === 'html' && current.current?.html) {
          html = current.current.html;
        } else if (file.kind === 'html' && file.previewUrl) {
          const url = new URL(file.previewUrl, window.location.href).href;
          const text = await api<string>(url, { cache: 'no-store', signal: readController.signal, timeoutMs: 15_000 });
          html = previewDocument(text, url);
        }
        if (disposed || readController.signal.aborted) return;
        if (!unchanged || renewHtml && file.kind === 'html') {
          const result = { file, html };
          current.current = result; setSnapshot(result);
        }
        renewHtml = false;
        failures = 0;
        setError(''); setLoading(false);
      } catch (reason) {
        if (disposed || readController.signal.aborted) return;
        setLoading(false);
        setError(reason instanceof HttpError && reason.status === 404
          ? '\u6587\u4ef6\u6682\u65f6\u4e0d\u5b58\u5728\uff0c\u6062\u590d\u540e\u4f1a\u81ea\u52a8\u66f4\u65b0\u3002'
          : reason instanceof Error ? reason.message : '\u9884\u89c8\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u91cd\u8bd5\u3002');
        if (reason instanceof HttpError && reason.status === 401) stop();
        else if (++failures <= 3 && !(reason instanceof HttpError && reason.status < 500)) {
          timer = setTimeout(() => { timer = undefined; request(); }, failures * 1000);
        }
      } finally {
        busy = false;
        if (controller === readController) controller = null;
        if (pending) request();
      }
    };
    const resume = () => {
      stop();
      if (disposed || document.hidden) return;
      renewHtml = true;
      request();
      stream = new EventSource(`/api/file-preview/watch?${new URLSearchParams({ path })}`);
      stream.onmessage = event => {
        try {
          const revision: unknown = JSON.parse(event.data).revision;
          if (typeof revision !== 'string' || revision === observed) return;
          observed = revision;
          if (revision !== current.current?.file.revision) request();
        } catch { /* Ignore malformed events; the next valid revision recovers. */ }
      };
      stream.onopen = () => { observed = ''; setWatchError(''); request(); };
      stream.onerror = () => {
        if (!disposed && !document.hidden) {
          setWatchError('\u5b9e\u65f6\u66f4\u65b0\u8fde\u63a5\u5df2\u4e2d\u65ad\uff0c\u6b63\u5728\u91cd\u8fde\u3002');
          request();
        }
      };
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    resume();
    return () => {
      disposed = true; stop();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [path, active, refresh]);
  return { file: snapshot?.file ?? null, html: snapshot?.html ?? null, error: error || watchError, loading };
}
