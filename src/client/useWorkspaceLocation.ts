import { useCallback, useEffect, useRef, useState } from 'react';

import { readWorkspaceLocation, workspaceLocationUrl, type WorkspaceLocation } from './workspace-location';

interface WorkspaceNavigation {
  authenticated: boolean;
  activeThreadId: string | null;
  showArchived: boolean;
  openThread: (threadId: string) => Promise<void>;
  closeThread: () => void;
  toggleArchived: () => Promise<void>;
  onError: (error: unknown) => void;
}

function commitLocation(target: WorkspaceLocation, mode: 'push' | 'replace') {
  const currentUrl = new URL(location.href);
  const currentSelection = readWorkspaceLocation(currentUrl);
  if (currentSelection.threadId === target.threadId && currentSelection.archived === target.archived) return;
  const url = workspaceLocationUrl(currentUrl, target);
  if (url.href !== location.href) {
    if (mode === 'push') history.pushState(null, '', url);
    else history.replaceState(history.state, '', url);
  }
}

export function useWorkspaceLocation(options: WorkspaceNavigation) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<WorkspaceLocation | null>(readWorkspaceLocation(new URL(location.href)));
  const [revision, setRevision] = useState(0);
  const request = useCallback((target: WorkspaceLocation) => {
    pending.current = target;
    setRevision(value => value + 1);
  }, []);
  const navigate = useCallback((target: WorkspaceLocation) => {
    commitLocation(target, 'push');
    request(target);
  }, [request]);

  useEffect(() => {
    const onPop = () => request(readWorkspaceLocation(new URL(location.href)));
    const onNotification = (event: MessageEvent) => {
      if (event.data?.type === 'notification.open' && typeof event.data.threadId === 'string') {
        navigate({ threadId: event.data.threadId, archived: false });
      }
    };
    window.addEventListener('popstate', onPop);
    navigator.serviceWorker?.addEventListener('message', onNotification);
    return () => {
      window.removeEventListener('popstate', onPop);
      navigator.serviceWorker?.removeEventListener('message', onNotification);
    };
  }, [navigate, request]);

  useEffect(() => {
    const target = pending.current;
    if (!options.authenticated || !target) return;
    let cancelled = false;
    const current = () => !cancelled && pending.current === target;
    void (async () => {
      try {
        if (latest.current.showArchived !== target.archived) await latest.current.toggleArchived();
        if (!current()) return;
        if (target.threadId) await latest.current.openThread(target.threadId);
        else latest.current.closeThread();
      } catch (error) {
        if (current()) latest.current.onError(error);
      } finally {
        if (current()) {
          pending.current = null;
          setRevision(value => value + 1);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [options.authenticated, revision]);

  useEffect(() => {
    if (!options.authenticated || pending.current) return;
    // Native create/fork/archive actions may change selection without a sidebar click.
    commitLocation({ threadId: options.activeThreadId, archived: options.showArchived }, 'push');
  }, [options.authenticated, options.activeThreadId, options.showArchived, revision]);

  return navigate;
}
