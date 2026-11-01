import type { ThreadItem } from './types';
import { itemKey } from './remote-state';

export type TimelineEntry =
  | { type: 'message'; key: string; item: ThreadItem }
  | { type: 'event'; key: string; item: ThreadItem }
  | {
      type: 'activity';
      key: string;
      kind: ActivityKind;
      kinds: ActivityKind[];
      items: ThreadItem[];
      failedCount: number;
      declinedCount: number;
      running: boolean;
    };

export type ActivityKind = 'command' | 'file' | 'reasoning' | 'tool' | 'search' | 'image';

export function buildTimelineEntries(
  items: ThreadItem[], activeTurnId: string | null = null, previous: TimelineEntry[] = []
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const activityKeys = new Map<string, string>();
  const retainedActivityKeys = new Set<string>();
  for (const entry of previous) {
    if (entry.type === 'activity') for (const item of entry.items) activityKeys.set(itemKey(item), entry.key);
  }
  let activityItems: ThreadItem[] = [];
  const flushActivity = (isLast = false) => {
    if (activityItems.length === 0) return;
    const failedCount = activityItems.filter((item) => 'status' in item && item.status === 'failed').length;
    const declinedCount = activityItems.filter((item) => 'status' in item && item.status === 'declined').length;
    const running = isLast && activeTurnId !== null && activityItems[0]!.turnId === activeTurnId &&
      activityItems[0]!.type !== 'imageView';
    const kinds = [...new Set(activityItems.map((item) => activityKind(item)!))];
    const kind = (['tool', 'file', 'command', 'search', 'image'] as ActivityKind[]).find((kind) => kinds.includes(kind))!;
    const baseKey = `activity-${itemKey(activityItems[0]!)}`;
    let key = activityItems.map(item => activityKeys.get(itemKey(item)))
      .find(key => key && !retainedActivityKeys.has(key)) ?? baseKey;
    let suffix = 1;
    while (retainedActivityKeys.has(key)) key = `${baseKey}-${++suffix}`;
    retainedActivityKeys.add(key);
    entries.push({
      type: 'activity',
      key,
      kind,
      kinds,
      items: activityItems,
      failedCount,
      declinedCount,
      running
    });
    activityItems = [];
  };

  items.forEach((item) => {
    if (item.type === 'reasoning' || item.type === 'imageGeneration') return;
    if (item.type === 'webSearch' && !item.query?.trim()) return;
    if (item.type === 'agentMessage' && !item.text.trim() && !item.questions?.length) return;
    if (activityItems.length > 0 && (item.turnId !== activityItems[0]!.turnId ||
      item.type === 'imageView' || activityItems[0]!.type === 'imageView')) flushActivity();
    if (isConversationItem(item)) {
      flushActivity();
      entries.push({
        type: 'message',
        key: `message-${itemKey(item)}`,
        item
      });
      return;
    }
    if (activityKind(item)) activityItems.push(item);
    else {
      flushActivity();
      entries.push({ type: 'event', key: `event-${itemKey(item)}`, item });
    }
  });
  flushActivity(true);
  const previousByKey = new Map(previous.map(entry => [entry.key, entry]));
  return entries.map(entry => {
    const existing = previousByKey.get(entry.key);
    if (!existing) return entry;
    if (entry.type === 'activity' && existing.type === 'activity') {
      return entry.running === existing.running && entry.items.length === existing.items.length &&
        entry.items.every((item, index) => item === existing.items[index]) ? existing : entry;
    }
    return entry.type !== 'activity' && existing.type === entry.type && entry.item === existing.item ? existing : entry;
  });
}

function activityKind(item: ThreadItem): ActivityKind | null {
  switch (item.type) {
    case 'commandExecution': return 'command';
    case 'fileChange': return 'file';
    case 'reasoning': return 'reasoning';
    case 'mcpToolCall':
    case 'dynamicToolCall': return 'tool';
    case 'webSearch': return 'search';
    case 'imageView': return 'image';
    default: return null;
  }
}

export function isConversationItem(item: ThreadItem): boolean {
  return item.type === 'userMessage' || item.type === 'agentMessage';
}

export function isActivityIssue(item: ThreadItem): boolean {
  return 'status' in item && (item.status === 'failed' || item.status === 'declined');
}

export interface TimelineSection {
  key: string;
  turnId: string | undefined;
  entries: TimelineEntry[];
  user: boolean;
  showTiming: boolean;
}

export function buildTimelineSections(entries: TimelineEntry[], previous: TimelineSection[] = []): TimelineSection[] {
  const sections: TimelineSection[] = [];
  const firstResponse = new Map<string, TimelineSection>();
  for (const entry of entries) {
    const item = entry.type === 'activity' ? entry.items[0]! : entry.item;
    const user = item.type === 'userMessage';
    let section = sections.at(-1);
    if (!section || user || section.user || section.turnId !== item.turnId) {
      section = { key: entry.key, turnId: item.turnId, entries: [], user, showTiming: false };
      sections.push(section);
    }
    section.entries.push(entry);
    if (!user && item.turnId && !firstResponse.has(item.turnId)) firstResponse.set(item.turnId, section);
  }
  for (const section of firstResponse.values()) section.showTiming = true;
  // A page can begin inside a response. Keep its identity when its prefix arrives.
  const previousByItem = new Map<string, string>();
  for (const section of previous) {
    for (const entry of section.entries) {
      const items = entry.type === 'activity' ? entry.items : [entry.item];
      for (const item of items) previousByItem.set(itemKey(item), section.key);
    }
  }
  const retained = new Set<string>();
  for (const section of sections) {
    const key = section.entries.flatMap(entry => (entry.type === 'activity' ? entry.items : [entry.item])
      .map(item => previousByItem.get(itemKey(item)))).find(key => key && !retained.has(key));
    if (key) section.key = key;
    retained.add(section.key);
  }
  const previousByKey = new Map(previous.map(section => [section.key, section]));
  return sections.map(section => {
    const existing = previousByKey.get(section.key);
    return existing && existing.showTiming === section.showTiming && existing.entries.length === section.entries.length &&
      existing.entries.every((entry, index) => entry === section.entries[index]) ? existing : section;
  });
}

export function finalAnswerIndex(entries: TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === 'message' && entry.item.type === 'agentMessage' &&
      entry.item.phase !== 'commentary' && entry.item.phase !== 'partial_answer' &&
      entry.item.text.trim()) return index;
  }
  return -1;
}

export function timelineTurnResponses(sections: TimelineSection[]) {
  const turns = new Map<string, { finalStartedAtMs: number | null; hasTrace: boolean; lastResponseKey: string }>();
  for (const section of sections) {
    if (section.user || !section.turnId) continue;
    const turn = turns.get(section.turnId) ?? { finalStartedAtMs: null, hasTrace: false, lastResponseKey: section.key };
    const finalIndex = finalAnswerIndex(section.entries);
    const final = section.entries[finalIndex];
    if (final?.type === 'message') turn.finalStartedAtMs = final.item.startedAtMs ?? null;
    turn.hasTrace ||= (finalIndex < 0 ? section.entries.length : finalIndex) > 0;
    turn.lastResponseKey = section.key;
    turns.set(section.turnId, turn);
  }
  return turns;
}
