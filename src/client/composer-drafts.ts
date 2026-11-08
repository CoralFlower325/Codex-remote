import type { ComposerAttachment, SkillInfo } from './types';

export interface ComposerInput {
  text: string;
  attachments: ComposerAttachment[];
  skills: SkillInfo[];
}

export interface ComposerDraft extends ComposerInput { sending: boolean; recoveryNotice?: string | undefined }

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const contextKey = 'composer-context:v1';
const maxContextBytes = 4 * 1024 * 1024;
const omissionKey = 'composer-context:omitted';
const recoveryMessage = '部分附件或技能未能保存，请核对并重新添加。';
interface StoredContext {
  updatedAt: number;
  attachments: ComposerAttachment[];
  skills: SkillInfo[];
  omitted: string[];
}

function storedUrl(url: string, document = false): boolean {
  return /^\/api\/[^\s\\]*$/i.test(url) || (!document &&
    /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\r\n]+$/i.test(url));
}

function safeContext(input: ComposerInput): Omit<StoredContext, 'updatedAt'> {
  const attachments: ComposerAttachment[] = [];
  const omitted: string[] = [];
  let size = 0;
  for (const attachment of input.attachments.slice(0, 20)) {
    let saved: ComposerAttachment | undefined;
    if (attachment.id.length > 512 || attachment.name.length > 512) {
      omitted.push(attachment.name.slice(0, 160));
      continue;
    }
    if (attachment.kind === 'document') {
      if (!attachment.status && attachment.path && attachment.path.length <= 4096 &&
        attachment.uploadId && attachment.uploadId.length <= 512 && storedUrl(attachment.url, true)) {
        saved = { id: attachment.id, name: attachment.name, kind: 'document', path: attachment.path,
          url: attachment.url, uploadId: attachment.uploadId,
          ...(attachment.size != null ? { size: attachment.size } : {}) };
      }
    } else if (storedUrl(attachment.url)) {
      saved = { id: attachment.id, name: attachment.name, url: attachment.url, kind: 'image' };
    }
    const bytes = saved ? JSON.stringify(saved).length * 2 : 0;
    if (saved && bytes + size <= maxContextBytes / 2) { attachments.push(saved); size += bytes; }
    else omitted.push(attachment.name.slice(0, 160));
  }
  const skills = input.skills.slice(0, 40).filter(skill => {
    if (skill.name.length <= 512 && skill.path.length <= 4096) return true;
    omitted.push(skill.name.slice(0, 160)); return false;
  }).map(skill => ({ name: skill.name, path: skill.path,
    description: skill.description.slice(0, 2000), enabled: skill.enabled,
    ...(skill.interface?.displayName ? { interface: { displayName: skill.interface.displayName.slice(0, 160) } } : {}) }));
  omitted.push(...input.attachments.slice(20).map(entry => entry.name.slice(0, 160)),
    ...input.skills.slice(40).map(entry => entry.name.slice(0, 160)));
  return { attachments, skills, omitted: omitted.slice(0, 200) };
}

function readContexts(storage?: DraftStorage): { contexts: Record<string, StoredContext>; incomplete: boolean } {
  const contexts: Record<string, StoredContext> = Object.create(null);
  try {
    const raw = storage?.getItem(contextKey);
    if (!raw) return { contexts, incomplete: false };
    if (raw.length * 2 > maxContextBytes) return { contexts, incomplete: true };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { contexts, incomplete: true };
    let incomplete = false;
    for (const [key, context] of Object.entries(value)) {
      const valid = key.length <= 512 && context && typeof context === 'object' &&
      Number.isFinite(context.updatedAt) && context.updatedAt <= Date.now() + 300_000 &&
      Date.now() - context.updatedAt < 24 * 60 * 60_000 &&
      Array.isArray(context.attachments) && context.attachments.length <= 20 &&
      context.attachments.every((entry: ComposerAttachment) => entry && typeof entry.id === 'string' &&
        entry.id.length <= 512 && typeof entry.name === 'string' && entry.name.length <= 512 &&
        typeof entry.url === 'string' && storedUrl(entry.url, entry.kind === 'document') &&
        (entry.kind === 'document' ? typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 4096 &&
          typeof entry.uploadId === 'string' && entry.uploadId.length > 0 && entry.uploadId.length <= 512 && !entry.status
          : entry.kind === 'image' || entry.kind === undefined)) &&
      Array.isArray(context.skills) && context.skills.length <= 40 &&
      context.skills.every((entry: SkillInfo) => entry && typeof entry.name === 'string' &&
        entry.name.length <= 512 && typeof entry.path === 'string' && entry.path.length <= 4096 &&
        typeof entry.description === 'string' && entry.description.length <= 2000 &&
        typeof entry.enabled === 'boolean' &&
        (!entry.interface || (typeof entry.interface === 'object' &&
          (entry.interface.displayName == null || typeof entry.interface.displayName === 'string')))) &&
      Array.isArray(context.omitted) && context.omitted.length <= 200 &&
      context.omitted.every((entry: unknown) => typeof entry === 'string' && entry.length <= 160);
      if (valid) {
        const safe = safeContext(context);
        contexts[key] = { ...safe, updatedAt: context.updatedAt, omitted: [...context.omitted, ...safe.omitted].slice(0, 200) };
      }
      else incomplete = true;
    }
    return { contexts, incomplete };
  } catch { return { contexts, incomplete: true }; }
}

export function clearComposerDraftContext(storage: DraftStorage = sessionStorage): void {
  try { storage.removeItem(contextKey); storage.removeItem(omissionKey); } catch { /* Browser storage can be disabled. */ }
}

export function createComposerDrafts(storage?: DraftStorage) {
  const drafts = new Map<string, ComposerDraft>();
  const listeners = new Map<string, Set<() => void>>();
  const { contexts, incomplete } = readContexts(storage);
  return {
    open(key: string, initial?: ComposerInput) {
      if (!drafts.has(key)) {
        let text = '';
        try { text = storage?.getItem(`draft:${key}`) ?? ''; } catch { /* Storage is optional. */ }
        const restored = contexts[key];
        let omitted = false;
        try { omitted = Boolean(!restored && (incomplete || storage?.getItem(omissionKey))); } catch { /* Optional storage. */ }
        drafts.set(key, { text, attachments: restored?.attachments ?? [], skills: restored?.skills ?? [],
          ...initial, sending: false, ...(restored?.omitted.length ? {
            recoveryNotice: `以下附件或技能未能恢复，请重新添加：${restored.omitted.join('、')}`
          } : omitted ? { recoveryNotice: recoveryMessage } : {}) });
      }
      return {
        get: () => drafts.get(key)!,
        subscribe(listener: () => void) {
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key)!.add(listener);
          return () => { listeners.get(key)?.delete(listener); };
        },
        update(change: (current: ComposerDraft) => ComposerDraft) {
          const previous = drafts.get(key)!;
          let next = change(previous);
          if (storage && (next.attachments !== previous.attachments || next.skills !== previous.skills)) {
            contexts[key] = { ...safeContext(next), updatedAt: Date.now() };
            for (const oldKey of Object.keys(contexts).filter(oldKey => oldKey !== key)
              .sort((a, b) => contexts[b]!.updatedAt - contexts[a]!.updatedAt).slice(29)) {
              delete contexts[oldKey];
              try { storage.setItem(omissionKey, '1'); } catch { /* Recovery notice is best effort. */ }
            }
            // Preserve omission warnings when old contexts must be dropped to stay
            // inside the shared browser quota. Never evict the current input.
            let serialized = JSON.stringify(contexts);
            for (const [oldKey, old] of Object.entries(contexts).sort(([, a], [, b]) => a.updatedAt - b.updatedAt)) {
              if (serialized.length * 2 <= maxContextBytes) break;
              if (oldKey === key) continue;
              contexts[oldKey] = { updatedAt: old.updatedAt, attachments: [], skills: [],
                omitted: [...old.omitted, ...old.attachments.map(entry => entry.name.slice(0, 160)),
                  ...old.skills.map(entry => entry.name.slice(0, 160))].slice(0, 200) };
              serialized = JSON.stringify(contexts);
            }
            try {
              if (serialized.length * 2 > maxContextBytes) throw new Error('Draft context too large');
              storage.setItem(contextKey, serialized);
              if (contexts[key]!.omitted.length) next = { ...next, recoveryNotice: recoveryMessage };
            } catch {
              // A failed write must not leave stale persisted attachment selections.
              try { storage.removeItem(contextKey); storage.setItem(omissionKey, '1'); } catch { /* Storage may be blocked. */ }
              next = { ...next, recoveryNotice: '浏览器无法保存附件草稿，刷新后需要重新添加附件和技能。' };
            }
          }
          drafts.set(key, next);
          if (next.text !== previous.text) {
            try {
              if (next.text) storage?.setItem(`draft:${key}`, next.text);
              else storage?.removeItem(`draft:${key}`);
            } catch { /* Keep the in-memory draft when browser storage is unavailable. */ }
          }
          listeners.get(key)?.forEach(listener => listener());
        }
      };
    }
  };
}

export function submittedComposerDraft(current: ComposerDraft, submitted: ComposerInput): ComposerDraft {
  return { ...current,
    text: current.text === submitted.text ? '' : current.text,
    attachments: current.attachments.filter(entry => !submitted.attachments.includes(entry)),
    skills: current.skills.filter(entry => !submitted.skills.includes(entry))
  };
}

export async function sendTransferredComposerDraft(drafts: ReturnType<typeof createComposerDrafts>,
  fromKey: string, toKey: string, submitted: ComposerInput, send: () => Promise<void>): Promise<void> {
  const source = drafts.open(fromKey);
  const target = drafts.open(toKey);
  const previous = target.get();
  const transferredText = `${submitted.text}${previous.text ? `\n${previous.text}` : ''}`;
  target.update(current => ({ ...current, text: transferredText, sending: true,
    attachments: [...new Set([...submitted.attachments, ...current.attachments])],
    skills: [...new Set([...submitted.skills, ...current.skills])] }));
  source.update(current => ({ ...submittedComposerDraft(current, submitted), sending: false }));
  try {
    await send();
    target.update(current => ({ ...submittedComposerDraft(current, submitted),
      text: current.text === transferredText ? previous.text : current.text, sending: false }));
  } finally {
    target.update(current => ({ ...current, sending: false }));
  }
}
