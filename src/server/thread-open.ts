import type { ClientRpcMethod } from '../shared/protocol.js';
import { projectTurnTiming, type TurnTiming } from '../shared/turn-timing.js';
import { isReadableHistoryItem } from '../shared/history-context.js';
import { compactHistoryEntries } from './history-payload.js';

type Request = (method: ClientRpcMethod, params: unknown) => Promise<unknown>;

interface HistoryEntry {
  turnId: string;
  item: unknown;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

interface HistoryPage {
  data: HistoryEntry[];
  nextCursor: string | null;
}

function hasConversationContext(entries: HistoryEntry[]): boolean {
  let user = false;
  let answer = false;
  for (const { item } of entries) {
    if (!isReadableHistoryItem(item)) continue;
    if ((item as { type: string }).type === 'userMessage') user = true;
    else answer = true;
    if (user && answer) return true;
  }
  return false;
}

export async function readOpenThread(
  request: Request,
  threadId: string,
  mode: 'resume' | 'read' | 'new'
) {
  const [result, history] = await Promise.all([
    request('thread/read', { threadId, includeTurns: false }),
    mode === 'new'
      ? Promise.resolve({ data: [], nextCursor: null })
      : request('thread/items/list', { threadId, limit: 40, sortDirection: 'desc' })
  ]) as [unknown, HistoryPage];
  const entries = [...history.data];
  let nextCursor = history.nextCursor;
  const cursors = new Set<string>();
  // A tool-heavy tail can contain no visible conversation at all.
  for (let page = 0; page < 2 && nextCursor && !hasConversationContext(entries); page++) {
    if (cursors.has(nextCursor)) break;
    cursors.add(nextCursor);
    let older: HistoryPage;
    try {
      older = await request('thread/items/list', {
        threadId, limit: 100, sortDirection: 'desc', cursor: nextCursor
      }) as HistoryPage;
    } catch { break; }
    entries.push(...older.data);
    nextCursor = older.nextCursor;
  }
  return {
    result,
    items: compactHistoryEntries(entries.reverse()),
    nextCursor,
    activeTurnId: null,
    turns: [] as TurnTiming[],
    turnsCursor: null,
    timingsPending: mode !== 'new'
  };
}

export async function readThreadTimings(request: Request, threadId: string, cursor: string | null = null) {
  const result = await request('thread/turns/list', {
    threadId, limit: cursor ? 100 : 40, itemsView: 'notLoaded', ...(cursor ? { cursor } : {})
  }) as { data: TurnTiming[]; nextCursor?: string | null };
  return {
    turns: result.data.map(projectTurnTiming),
    turnsCursor: result.nextCursor ?? null,
    activeTurnId: result.data.find(turn => turn.status === 'inProgress')?.id ?? null
  };
}
