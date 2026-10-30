import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isAbortedRequest } from './api';
import type { ChatTransport } from './chat-transport';
import { mergeSummaryResources, type ThreadSummaryPage } from '../shared/thread-summary';

const empty = (): ThreadSummaryPage => ({
  outputs: [], sources: [], pullRequests: [], nextCursor: null, attachmentsCursor: null
});

export function useThreadSummary(threadId: string | undefined, enabled: boolean, transport: ChatTransport) {
  const [snapshot, setSnapshot] = useState({ threadId, data: empty() });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const mode = useRef<'head' | 'older' | 'reset'>('head');
  const index = useRef({ threadId, data: empty(), known: new Set<string>(), initialized: false });
  const refresh = useCallback(() => { mode.current = 'reset'; setRevision(value => value + 1); }, []);
  const loadMore = useCallback(() => { mode.current = 'older'; setRevision(value => value + 1); }, []);
  const updateHead = useCallback(() => { mode.current = 'head'; setRevision(value => value + 1); }, []);
  useEffect(() => {
    if (!enabled || !threadId) { setLoading(false); return; }
    if (index.current.threadId !== threadId) index.current = { threadId, data: empty(), known: new Set(), initialized: false };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runMode = mode.current;
    mode.current = 'head';
    const stored = index.current;
    const incremental = runMode === 'head' && stored.initialized;
    const known = new Set(stored.known);
    const prior = runMode === 'reset' ? empty() : stored.data;
    let result: ThreadSummaryPage = runMode === 'older' ? prior : { ...prior, pullRequests: [] };
    const publish = () => {
      stored.data = result;
      setSnapshot({ threadId, data: result });
    };
    const yieldPage = () => new Promise<void>(resolve => {
      const abort = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 100);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    setLoading(true); setError(null);
    void (async () => {
      let cursor: string | null = runMode === 'older' ? prior.nextCursor : null;
      let attachmentsCursor: string | null = null;
      const seen = new Set<string>();
      const newKeys: string[] = [];
      const found: ThreadSummaryPage = empty();
      try {
        for (let count = 0; count < 10; count++) {
          const query: URLSearchParams = new URLSearchParams({ threadId, ...(cursor ? { cursor } : {}) });
          const page: ThreadSummaryPage = await api<ThreadSummaryPage>(`/api/thread/summary?${query}`, {
            signal: controller.signal, timeoutMs: 15000, cache: 'no-store'
          });
          if (controller.signal.aborted) return;
          const overlap = incremental && (page.itemKeys ?? []).some(key => known.has(key));
          newKeys.push(...page.itemKeys ?? []);
          found.outputs = mergeSummaryResources(found.outputs, page.outputs);
          found.sources = mergeSummaryResources(found.sources, page.sources);
          result = {
            outputs: mergeSummaryResources(runMode === 'older' ? prior.outputs : found.outputs,
              runMode === 'older' ? found.outputs : prior.outputs),
            sources: mergeSummaryResources(runMode === 'older' ? prior.sources : found.sources,
              runMode === 'older' ? found.sources : prior.sources),
            pullRequests: count === 0 && runMode !== 'older' ? page.pullRequests : result.pullRequests,
            nextCursor: overlap ? prior.nextCursor : page.nextCursor,
            attachmentsCursor: count === 0 && runMode !== 'older' ? page.attachmentsCursor : result.attachmentsCursor
          };
          if (count === 0 && runMode !== 'older') attachmentsCursor = page.attachmentsCursor;
          stored.known = new Set([...newKeys, ...stored.known].slice(0, 1000));
          stored.initialized = true;
          publish();
          if (overlap || !page.nextCursor) break;
          if (seen.has(page.nextCursor)) throw new Error('Summary cursor repeated. Please retry.');
          seen.add(page.nextCursor); cursor = page.nextCursor;
          await yieldPage();
        }
        // Attachments have an independent directory; replace it to reflect removals.
        const attachmentCursors = new Set<string>();
        while (attachmentsCursor) {
          if (attachmentCursors.has(attachmentsCursor)) throw new Error('Attachment cursor repeated. Please retry.');
          attachmentCursors.add(attachmentsCursor);
          const query: URLSearchParams = new URLSearchParams({ threadId, attachmentsOnly: '1', attachmentsCursor });
          const page: ThreadSummaryPage = await api<ThreadSummaryPage>(`/api/thread/summary?${query}`, {
            signal: controller.signal, timeoutMs: 15000, cache: 'no-store'
          });
          if (controller.signal.aborted) return;
          result = { ...result, pullRequests: mergeSummaryResources(result.pullRequests, page.pullRequests),
            attachmentsCursor: page.attachmentsCursor };
          attachmentsCursor = page.attachmentsCursor;
          publish(); await yieldPage();
        }
        stored.known = new Set([...newKeys, ...stored.known].slice(0, 1000));
        stored.initialized = true;
      } catch (failure) {
        if (!controller.signal.aborted && !isAbortedRequest(failure)) setError(failure instanceof Error ? failure.message : String(failure));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [threadId, enabled, revision]);
  useEffect(() => {
    if (!enabled || !threadId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = transport.subscribe((method, params) => {
      if (params.threadId !== threadId && method !== 'remote/connected') return;
      if (!['thread/attachment/updated', 'turn/completed', 'remote/connected'].includes(method)) return;
      clearTimeout(timer); timer = setTimeout(updateHead, 250);
    });
    const foreground = () => { if (document.visibilityState === 'visible') updateHead(); };
    document.addEventListener('visibilitychange', foreground);
    return () => { unsubscribe(); clearTimeout(timer); document.removeEventListener('visibilitychange', foreground); };
  }, [threadId, enabled, transport, updateHead]);
  return { data: snapshot.threadId === threadId ? snapshot.data : empty(), loading, error, refresh, loadMore };
}
