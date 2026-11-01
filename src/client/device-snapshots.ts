import type { ProjectInfo, Thread, ThreadHistoryItemEntry, ThreadHistoryPage, ThreadItem } from './types';

const DATABASE = 'remote-device-snapshots-v1';
const STORE = 'snapshots';
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;

export interface DeviceWorkspace {
  threads: Thread[];
  projects: ProjectInfo[];
}

export interface DeviceChat {
  thread: Thread;
  page: ThreadHistoryPage;
}

interface Saved<T> {
  savedAt: number;
  value: T;
}

export interface DeviceSnapshots {
  workspace: Saved<DeviceWorkspace> | null;
  chats: Array<Saved<DeviceChat>>;
}

let database: Promise<IDBDatabase | null> | null = null;
let writes = Promise.resolve();
let generation = 0;

function openDatabase(): Promise<IDBDatabase | null> {
  if (database) return database;
  database = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const request = indexedDB.open(DATABASE, 1);
      let settled = false;
      const finish = (value: IDBDatabase | null) => {
        if (settled) { value?.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 1000);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = null;
        };
        finish(request.result);
      };
    } catch { resolve(null); }
  });
  return database;
}

function persistable(thread: Thread): boolean {
  const source = thread.source as { subAgent?: unknown } | null;
  return !thread.ephemeral && !(source && typeof source === 'object' && source.subAgent);
}

export function projectDeviceThread(thread: Thread): Thread {
  return {
    id: thread.id,
    name: thread.name?.slice(0, 512) ?? null,
    preview: thread.preview.slice(0, 512),
    cwd: thread.cwd,
    projectId: thread.projectId,
    model: thread.model,
    modelProvider: thread.modelProvider,
    reasoningEffort: thread.reasoningEffort,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archived: Boolean(thread.archived),
    status: { type: 'notLoaded' }
  };
}

function projectItem(item: ThreadItem): ThreadItem | null {
  const timing = {
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.startedAtMs !== undefined ? { startedAtMs: item.startedAtMs } : {}),
    ...(item.completedAtMs !== undefined ? { completedAtMs: item.completedAtMs } : {})
  };
  switch (item.type) {
    case 'userMessage':
      return { type: item.type, id: item.id, ...timing,
        content: item.content.filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => ({ type: 'text', text: part.text! })) };
    case 'agentMessage':
      return { type: item.type, id: item.id, text: item.text, ...timing,
        ...(item.phase !== undefined ? { phase: item.phase } : {}) };
    case 'commandExecution':
      return item.status === 'inProgress' ? null : {
        type: item.type, id: item.id, command: item.command, cwd: item.cwd, status: item.status,
        aggregatedOutput: null, exitCode: item.exitCode, durationMs: item.durationMs, detailsDeferred: true, ...timing
      };
    case 'fileChange':
      return item.status === 'inProgress' ? null : {
        type: item.type, id: item.id, status: item.status,
        changes: item.changes.map(change => ({ path: change.path, ...(change.kind ? { kind: change.kind } : {}) })),
        detailsDeferred: true, ...timing
      };
    case 'webSearch':
      return { type: item.type, id: item.id, ...timing,
        ...(item.query !== undefined ? { query: item.query } : {}) };
    case 'contextCompaction':
      return { type: item.type, id: item.id, ...timing };
    default:
      return null;
  }
}

export function projectDeviceChat(thread: Thread, page: ThreadHistoryPage): DeviceChat | null {
  if (!persistable(thread)) return null;
  const unfinished = new Set(page.turns.filter(turn => turn.status === 'inProgress').map(turn => turn.id));
  if (page.activeTurnId) unfinished.add(page.activeTurnId);
  const items = page.items.slice(-40).flatMap((entry): ThreadHistoryItemEntry[] => {
    if (unfinished.has(entry.turnId)) return [];
    const item = projectItem(entry.item);
    return item ? [{
      turnId: entry.turnId, item, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs
    }] : [];
  });
  const turnIds = new Set(items.map(entry => entry.turnId));
  return {
    thread: projectDeviceThread(thread),
    page: {
      items,
      nextCursor: null,
      activeTurnId: null,
      turns: page.turns.filter(turn => turnIds.has(turn.id) && !unfinished.has(turn.id))
        .map(({ id, status, startedAt, completedAt, durationMs }) =>
          ({ id, status, startedAt, completedAt, durationMs })),
      turnsCursor: null
    }
  };
}

export function trimDeviceSnapshots(state: DeviceSnapshots, now = Date.now()): DeviceSnapshots {
  const current = <T>(saved: Saved<T>) => now - saved.savedAt <= MAX_AGE;
  const workspace = state.workspace && current(state.workspace) ? state.workspace : null;
  const result: DeviceSnapshots = {
    workspace: workspace ? {
      savedAt: workspace.savedAt,
      value: {
        threads: workspace.value.threads.filter(persistable).slice(0, 1000).map(projectDeviceThread),
        projects: workspace.value.projects.slice(0, 200).map(project => ({
          id: project.id, name: project.name,
          roots: project.roots.map(root => ({ path: root.path })),
          ...(project.position !== undefined ? { position: project.position } : {})
        }))
      }
    } : null,
    chats: state.chats.filter(current).slice(-3).map(saved => ({
      savedAt: saved.savedAt,
      value: {
        thread: saved.value.thread,
        page: { ...saved.value.page, items: [...saved.value.page.items], turns: [...saved.value.page.turns] }
      }
    }))
  };
  const bytes = () => new TextEncoder().encode(JSON.stringify(result)).byteLength;
  while (bytes() > MAX_BYTES && result.chats.length > 1) result.chats.shift();
  while (bytes() > MAX_BYTES && result.chats[0]?.value.page.items.length) {
    result.chats[0].value.page.items.shift();
    const ids = new Set(result.chats[0].value.page.items.map(entry => entry.turnId));
    result.chats[0].value.page.turns = result.chats[0].value.page.turns.filter(turn => ids.has(turn.id));
  }
  while (bytes() > MAX_BYTES && result.workspace?.value.threads.length) {
    result.workspace.value.threads.length = Math.floor(result.workspace.value.threads.length / 2);
  }
  if (bytes() > MAX_BYTES) return { workspace: null, chats: [] };
  return result;
}

async function read(): Promise<DeviceSnapshots | null> {
  const ticket = generation;
  const db = await openDatabase();
  if (!db || ticket !== generation) return null;
  return new Promise(resolve => {
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.get('current');
      request.onsuccess = () => {
        if (ticket !== generation || !request.result) { resolve(null); return; }
        const current = request.result as DeviceSnapshots;
        const result = trimDeviceSnapshots(current);
        if (Boolean(result.workspace) !== Boolean(current.workspace) || result.chats.length !== current.chats.length) {
          store.put(result, 'current');
        }
        resolve(result);
      };
      request.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

function update(change: (current: DeviceSnapshots) => DeviceSnapshots, ticket = generation): Promise<void> {
  writes = writes.then(async () => {
    if (ticket !== generation) return;
    const db = await openDatabase();
    if (!db || ticket !== generation) return;
    await new Promise<void>(resolve => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = store.get('current');
        request.onsuccess = () => {
          if (ticket !== generation) return;
          const current = (request.result as DeviceSnapshots | undefined) ?? { workspace: null, chats: [] };
          store.put(trimDeviceSnapshots(change(current)), 'current');
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch { resolve(); }
    });
  }).catch(() => undefined);
  return writes;
}

// Call reads only after server authentication. These snapshots never authorize actions.
export async function readDeviceWorkspace(): Promise<DeviceWorkspace | null> {
  return (await read())?.workspace?.value ?? null;
}

export function saveDeviceWorkspace(threads: Thread[], projects: ProjectInfo[]): Promise<void> {
  const workspace = { savedAt: Date.now(), value: { threads, projects } };
  return update(current => ({ ...current, workspace }));
}

export async function readDeviceChat(threadId: string): Promise<DeviceChat | null> {
  const value = (await read())?.chats.find(saved => saved.value.thread.id === threadId)?.value;
  return value ? projectDeviceChat(value.thread, value.page) : null;
}

export function saveDeviceChat(thread: Thread, page: ThreadHistoryPage): Promise<void> {
  const value = projectDeviceChat(thread, page);
  if (!value || value.page.items.length === 0) return Promise.resolve();
  const saved = { savedAt: Date.now(), value };
  return update(current => ({
    ...current,
    chats: [...current.chats.filter(chat => chat.value.thread.id !== thread.id), saved]
  }));
}

export function removeDeviceChat(threadId: string): Promise<void> {
  return update(current => ({
    ...current,
    chats: current.chats.filter(chat => chat.value.thread.id !== threadId),
    workspace: current.workspace ? {
      savedAt: current.workspace.savedAt,
      value: {
        ...current.workspace.value,
        threads: current.workspace.value.threads.filter(thread => thread.id !== threadId)
      }
    } : null
  }));
}

export function clearDeviceSnapshots(): Promise<void> {
  generation++;
  return update(() => ({ workspace: null, chats: [] }));
}
