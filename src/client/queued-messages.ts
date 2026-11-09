import type { ComposerAttachment, SkillInfo } from './types';
import { withSkillMentions, withoutLeadingSkillMentions } from '../shared/skill-input';
import { documentDraft } from '../shared/document-input';
import { previewContentUrl } from '../shared/file-preview';

export type ChatInput = ReturnType<typeof import('./slash-commands').turnInput>;
export interface QueuedSubmission {
  id: string;
  clientUserMessageId: string;
  input: ChatInput;
}

export function mergeQueuedMessages(native: QueuedSubmission[], optimistic: QueuedSubmission[]) {
  const nativeClientIds = new Set(native.map(message => message.clientUserMessageId));
  const settledClientUserMessageIds = optimistic
    .filter(message => nativeClientIds.has(message.clientUserMessageId))
    .map(message => message.clientUserMessageId);
  return {
    messages: [
      ...native,
      ...optimistic.filter(message => !nativeClientIds.has(message.clientUserMessageId))
    ],
    settledClientUserMessageIds
  };
}

export function queuedDraft(input: ChatInput) {
  const skills = input.flatMap((part): SkillInfo[] => part.type === 'skill' && 'name' in part && 'path' in part
    ? [{ name: part.name, path: part.path, description: '', enabled: true }] : []);
  const text = input.flatMap(part => part.type === 'text' && 'text' in part ? [part.text] : []).join('\n');
  const documentInput = documentDraft(text);
  return {
    text: withoutLeadingSkillMentions(documentInput?.text ?? text, skills),
    attachments: [
      ...input.flatMap((part, index): ComposerAttachment[] =>
        part.type === 'image' && 'url' in part ? [{ id: `image-${index}`, name: 'Image', url: part.url }] : []),
      ...(documentInput?.documents ?? []).map((document, index): ComposerAttachment => ({
        ...document, kind: 'document', id: `document-${index}`, url: previewContentUrl(document.path)
      }))
    ],
    skills
  };
}

export function replaceQueuedText(input: ChatInput, text: string): ChatInput {
  const original = input.flatMap(part => part.type === 'text' && 'text' in part ? [part.text] : []).join('\n');
  const boundary = /^\s*# (?:Files|Applications) mentioned by the user:[ \t]*\r?\n/.test(original)
    ? /^## My request:[ \t]*\r?\n/m.exec(original) : null;
  const prefix = boundary ? original.slice(0, boundary.index + boundary[0].length) : '';
  return [
    { type: 'text', text: prefix + withSkillMentions(text, queuedDraft(input).skills), text_elements: [] },
    ...input.filter(part => part.type !== 'text')
  ];
}
