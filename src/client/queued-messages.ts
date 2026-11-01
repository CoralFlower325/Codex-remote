import type { ComposerAttachment, SkillInfo } from './types';
import { withSkillMentions, withoutLeadingSkillMentions } from '../shared/skill-input';

export type ChatInput = ReturnType<typeof import('./slash-commands').turnInput>;
export interface QueuedSubmission {
  id: string;
  clientUserMessageId: string;
  input: ChatInput;
}

export function queuedDraft(input: ChatInput) {
  const skills = input.flatMap((part): SkillInfo[] => part.type === 'skill' && 'name' in part && 'path' in part
    ? [{ name: part.name, path: part.path, description: '', enabled: true }] : []);
  return {
    text: withoutLeadingSkillMentions(input.flatMap(part =>
      part.type === 'text' && 'text' in part ? [part.text] : []).join('\n'), skills),
    attachments: input.flatMap((part, index): ComposerAttachment[] =>
      part.type === 'image' && 'url' in part ? [{ id: `image-${index}`, name: 'Image', url: part.url }] : []),
    skills
  };
}

export function replaceQueuedText(input: ChatInput, text: string): ChatInput {
  return [
    { type: 'text', text: withSkillMentions(text, queuedDraft(input).skills), text_elements: [] },
    ...input.filter(part => part.type !== 'text')
  ];
}
