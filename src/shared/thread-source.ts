export function isTaskThread(thread: { ephemeral?: boolean; source?: unknown }): boolean {
  return !thread.ephemeral && !(thread.source && typeof thread.source === 'object' &&
    'subAgent' in thread.source);
}

export function isSideConversationThread(thread: { threadSource?: string | null; source?: unknown }): boolean {
  const source = typeof thread.source === 'string' ? thread.source
    : thread.source && typeof thread.source === 'object'
      ? Object.values(thread.source as Record<string, unknown>).filter(value => typeof value === 'string').join(' ')
      : '';
  return /(?:^|[^a-z])(?:queued_)?side_chat(?:$|[^a-z])/i.test(
    `${thread.threadSource ?? ''} ${source}`
  );
}
