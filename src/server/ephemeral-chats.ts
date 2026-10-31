import { projectTurnTiming, runtimeTurnError, type TurnTiming } from '../shared/turn-timing.js';

export interface EphemeralSnapshot {
  items: Array<Record<string, unknown>>;
  turns: TurnTiming[];
  activeTurnId: string | null;
}

// A short disconnect grace keeps temporary chats alive during socket recovery.
export class EphemeralChats<Owner> {
  private entries = new Map<string, { owner: Owner; timer?: ReturnType<typeof setTimeout>;
    items: Map<string, Record<string, unknown>>; turns: Map<string, TurnTiming>; activeTurnId: string | null }>();

  constructor(private release: (threadId: string) => Promise<unknown>, private graceMs = 30_000) {}

  add(threadId: string, owner: Owner) {
    this.remove(threadId);
    this.entries.set(threadId, { owner, items: new Map(), turns: new Map(), activeTurnId: null });
  }

  claim(threadIds: string[], owner: Owner) {
    for (const id of threadIds) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      entry.owner = owner;
    }
  }

  remove(threadId: string) {
    clearTimeout(this.entries.get(threadId)?.timer);
    this.entries.delete(threadId);
  }

  snapshot(threadId: string): EphemeralSnapshot | null {
    const entry = this.entries.get(threadId);
    return entry ? { items: [...entry.items.values()], turns: [...entry.turns.values()], activeTurnId: entry.activeTurnId } : null;
  }

  recordInput(threadId: string, turnId: string, id: string, input: unknown[]) {
    const entry = this.entries.get(threadId);
    entry?.items.set(JSON.stringify([turnId, id]), { type: 'userMessage', id, turnId, content: input });
  }

  record(method: string, params: Record<string, unknown>) {
    const entry = this.entries.get(String(params.threadId ?? ''));
    if (!entry) return;
    const runtimeId = typeof params.turnId === 'string' ? params.turnId : '';
    const previous = entry.turns.get(runtimeId);
    const errors = runtimeTurnError(previous ? { [runtimeId]: previous } : {}, method, params);
    const runtime = errors[runtimeId];
    if (runtime) entry.turns.set(runtime.id, runtime);
    if (method === 'turn/started' || method === 'turn/completed') {
      const { items = [], ...turn } = params.turn as TurnTiming & { items?: Array<Record<string, unknown>> };
      entry.turns.set(turn.id, projectTurnTiming(turn));
      entry.activeTurnId = method === 'turn/started' ? turn.id : null;
      for (const item of items) {
        const key = JSON.stringify([turn.id, item.id]);
        entry.items.set(key, { ...entry.items.get(key), ...item, turnId: turn.id });
      }
    }
    const turnId = String(params.turnId ?? '');
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as Record<string, unknown>;
      const key = JSON.stringify([turnId, item.id]);
      entry.items.set(key, { ...entry.items.get(key), ...item, turnId,
        ...(method === 'item/started' ? { startedAtMs: params.startedAtMs }
          : { completedAtMs: params.completedAtMs }) });
    }
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      const key = JSON.stringify([turnId, params.itemId]);
      const item = entry.items.get(key) ?? { id: params.itemId, turnId, type: 'agentMessage' };
      const field = method === 'item/agentMessage/delta' ? 'text' : 'aggregatedOutput';
      entry.items.set(key, { ...item, [field]: `${item[field] ?? ''}${String(params.delta ?? '')}` });
    }
  }

  disconnect(owner: Owner) {
    for (const [id, entry] of this.entries) {
      if (entry.owner !== owner) continue;
      entry.timer = setTimeout(() => {
        this.entries.delete(id);
        void this.release(id).catch(() => undefined);
      }, this.graceMs);
      entry.timer.unref?.();
    }
  }
}
