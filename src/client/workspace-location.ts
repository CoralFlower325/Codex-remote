export interface WorkspaceLocation {
  threadId: string | null;
  archived: boolean;
}

export function readWorkspaceLocation(url: URL): WorkspaceLocation {
  const threadId = url.searchParams.get('thread');
  return {
    threadId: threadId && threadId.length <= 256 && !/[\u0000-\u001f]/.test(threadId) ? threadId : null,
    archived: url.searchParams.get('archived') === '1'
  };
}

export function workspaceLocationUrl(url: URL, location: WorkspaceLocation): URL {
  const next = new URL(url);
  if (location.threadId) next.searchParams.set('thread', location.threadId);
  else next.searchParams.delete('thread');
  if (location.archived) next.searchParams.set('archived', '1');
  else next.searchParams.delete('archived');
  return next;
}
