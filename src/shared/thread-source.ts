export function isTaskThread(thread: { ephemeral?: boolean; source?: unknown; threadSource?: string | null }): boolean {
  return !thread.ephemeral && !isSideConversationThread(thread) && !(thread.source && typeof thread.source === 'object' &&
    'subAgent' in thread.source);
}

export function isSideConversationThread(thread: { threadSource?: string | null; source?: unknown }): boolean {
  const sources = typeof thread.source === 'string' ? [thread.source]
    : thread.source && typeof thread.source === 'object'
      ? Object.values(thread.source as Record<string, unknown>)
      : [];
  return [thread.threadSource, ...sources].some(source => source === 'side_chat' || source === 'queued_side_chat');
}
