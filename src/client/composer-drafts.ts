import type { ComposerAttachment, SkillInfo } from './types';

export interface ComposerInput {
  text: string;
  attachments: ComposerAttachment[];
  skills: SkillInfo[];
}

export interface ComposerDraft extends ComposerInput { sending: boolean }

export function createComposerDrafts(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const drafts = new Map<string, ComposerDraft>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    open(key: string, initial?: ComposerInput) {
      if (!drafts.has(key)) {
        let text = '';
        try { text = storage?.getItem(`draft:${key}`) ?? ''; } catch { /* Storage is optional. */ }
        drafts.set(key, { text, attachments: [], skills: [], ...initial, sending: false });
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
          const next = change(previous);
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
