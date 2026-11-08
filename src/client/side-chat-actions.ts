import { v5 as fingerprint } from 'uuid';
import { actionIntent } from './action-intents';
import type { ChatInput } from './queued-messages';

const storageKey = 'codex-remote:side-input-actions:v1';
const namespace = 'ae81eb8c-7024-41db-b630-d81240f1c911';
type Attempt = { method: 'turn/start' | 'turn/steer'; expectedTurnId?: string };

function readAttempts(): Map<string, Attempt> {
  try {
    const records: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(records)) return new Map();
    return new Map(records.slice(-200).filter((entry): entry is [string, Attempt] =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
      /^[a-f0-9-]{36}$/.test(entry[0]) && entry[1] && typeof entry[1] === 'object' &&
      (entry[1].method === 'turn/start' || entry[1].method === 'turn/steer' &&
        typeof entry[1].expectedTurnId === 'string' && entry[1].expectedTurnId.length <= 256)));
  } catch { return new Map(); }
}

function persist(attempts: Map<string, Attempt>) {
  try { sessionStorage.setItem(storageKey, JSON.stringify([...attempts])); } catch { /* RPC identity still prevents duplicate writes. */ }
}

// A native turn event can arrive before its RPC acknowledgement. Keep the original
// mode so retrying the same draft retrieves that result instead of steering again.
export function sideChatAction(threadId: string, input: ChatInput, activeTurnId: string | null,
  startSettings: Record<string, unknown>) {
  const hash = fingerprint(JSON.stringify([threadId, input]), namespace);
  const attempts = readAttempts();
  const attempt = attempts.get(hash) ?? (activeTurnId
    ? { method: 'turn/steer' as const, expectedTurnId: activeTurnId }
    : { method: 'turn/start' as const });
  const params = { threadId, input, ...(attempt.method === 'turn/start' ? startSettings :
    { expectedTurnId: attempt.expectedTurnId }) };
  const identity = actionIntent(attempt.method, params)!;
  if (!attempts.has(hash) && attempts.size >= 200) throw new Error('待核对的侧聊操作过多，请先检查侧聊记录。');
  attempts.set(hash, attempt);
  persist(attempts);
  return {
    method: attempt.method, expectedTurnId: attempt.expectedTurnId,
    params: { ...params, clientUserMessageId: identity.id },
    complete() {
      identity.complete();
      const current = readAttempts();
      current.delete(hash);
      persist(current);
    }
  };
}
