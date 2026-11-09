import type { ClientRpcMethod } from './protocol.js';

export type CatalogKind = 'models' | 'projects';

export interface CatalogPage<T> {
  data: T[];
  nextCursor?: string | null;
}

export interface CatalogSnapshot<T> {
  data: T[];
  nextCursor: null;
  complete: true;
  generation: string;
  fetchedAt: number;
}

export interface CatalogReadOptions {
  maxPages?: number;
  now?: () => number;
  generation?: () => string;
}

type CatalogRead = (method: ClientRpcMethod, params: unknown) => Promise<unknown>;

const CATALOG_METHOD: Record<CatalogKind, ClientRpcMethod> = {
  models: 'model/list',
  projects: 'project/list'
};

const CATALOG_LIMIT: Record<CatalogKind, number> = {
  models: 100,
  projects: 200
};

const CATALOG_MAX_PAGES: Record<CatalogKind, number> = {
  models: 50,
  projects: 100
};

export function catalogItemKey(kind: CatalogKind, item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id === 'string' && record.id) return record.id;
  if (kind === 'models') {
    const provider = typeof record.modelProvider === 'string' ? record.modelProvider
      : typeof record.provider === 'string' ? record.provider : '';
    if (typeof record.model === 'string' && record.model) return `${provider}\0${record.model}`;
  }
  return null;
}

export function isCatalogSnapshot<T>(value: unknown): value is CatalogSnapshot<T> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.data) && record.complete === true && record.nextCursor === null &&
    typeof record.generation === 'string' && typeof record.fetchedAt === 'number';
}

export async function readCompleteCatalog<T>(
  read: CatalogRead,
  kind: CatalogKind,
  options: CatalogReadOptions = {}
): Promise<CatalogSnapshot<T>> {
  const maxPages = options.maxPages ?? CATALOG_MAX_PAGES[kind];
  const now = options.now ?? Date.now;
  const generation = options.generation ?? (() =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const items: T[] = [];
  const seenCursors = new Set<string>();
  const seenItems = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const result = await read(CATALOG_METHOD[kind], {
      limit: CATALOG_LIMIT[kind],
      ...(kind === 'models' ? { includeHidden: false } : {}),
      ...(cursor ? { cursor } : {})
    });
    if (!result || typeof result !== 'object' || !Array.isArray((result as CatalogPage<T>).data)) {
      throw new Error('Native catalog returned an invalid page.');
    }
    const page = result as CatalogPage<T>;
    for (const item of page.data) {
      const key = catalogItemKey(kind, item);
      if (key && seenItems.has(key)) continue;
      if (key) seenItems.add(key);
      items.push(item);
    }
    const next = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    if (!next) {
      return {
        data: items,
        nextCursor: null,
        complete: true,
        generation: generation(),
        fetchedAt: now()
      };
    }
    if (seenCursors.has(next)) throw new Error('Native catalog pagination repeated a cursor.');
    seenCursors.add(next);
    cursor = next;
  }

  throw new Error('Native catalog pagination exceeded its page limit.');
}
