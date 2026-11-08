import { v4 as randomUUID, v5 as fingerprint } from 'uuid';
import { needsActionIdentity } from '../shared/action-policy';

const key = 'codex-remote:pending-actions:v2';
const namespace = '94ac91ad-266e-4716-92f7-41dfbcc4fc5a';
const pending = new Map<string, { id: string; method: string }>();
let loaded = false;
function stableParams(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const { clientUserMessageId: _id, ...rest } = params as Record<string, unknown>;
  return rest;
}

function persist() {
  try { sessionStorage.setItem(key, JSON.stringify([...pending])); } catch { /* In-memory safety remains active. */ }
}

export function actionIntent(method: string, params: unknown): { id: string; complete: () => void } | null {
  if (!needsActionIdentity(method)) return null;
  if (!loaded) {
    loaded = true;
    try {
      const entries: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      if (Array.isArray(entries)) for (const entry of entries.slice(-200)) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
            /^[a-f0-9-]{36}$/.test(entry[0]) && entry[1] && typeof entry[1] === 'object' &&
            typeof entry[1].id === 'string' && /^[a-f0-9-]{36}$/.test(entry[1].id) &&
            typeof entry[1].method === 'string' && needsActionIdentity(entry[1].method)) pending.set(entry[0], entry[1]);
      }
    } catch { /* A damaged browser record never triggers a write. */ }
  }
  const inputAction = /^(?:turn\/(?:start|steer)|thread\/queue\/add)$/.test(method);
  const body = stableParams(params) as Record<string, unknown> | null;
  const hash = fingerprint(JSON.stringify(inputAction ? ['user-input', { threadId: body?.threadId, input: body?.input }] :
    [method, body]), namespace);
  const previous = pending.get(hash);
  if (previous && previous.method !== method) throw new Error(
    '同一条输入的上次操作结果尚未确认，可能已经执行。请先核对 Desktop 记录，不能改用排队或引导绕过确认。');
  const id = previous?.id ?? randomUUID();
  if (!pending.has(hash) && pending.size >= 200) throw new Error('待核对的操作过多，请先检查现有会话记录。');
  pending.set(hash, { id, method });
  persist();
  return { id, complete: () => { if (pending.get(hash)?.id === id) { pending.delete(hash); persist(); } } };
}

export function clearActionIntents() {
  pending.clear();
  loaded = true;
  try {
    sessionStorage.removeItem(key);
    sessionStorage.removeItem('codex-remote:side-input-actions:v1');
  } catch { /* Storage can be disabled. */ }
}
