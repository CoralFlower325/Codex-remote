import type { TurnTiming } from './turn-timing.js';
import { heartbeatResponseText, parseHeartbeatPrompt } from './heartbeat.js';
import { userMessageText } from './user-message.js';

export interface OutlineMessage {
  itemId: string;
  prompt: string;
  reply: string;
}

export interface OutlineTurn extends TurnTiming {
  messages: OutlineMessage[];
}

export interface OutlineItem {
  id: string;
  type: string;
  content?: Array<{ type: string; text?: string }>;
  text?: string;
  phase?: string | null;
}

export function outlineMessages(items: OutlineItem[]): OutlineMessage[] {
  const messages: OutlineMessage[] = [];
  for (const item of items) {
    if (item.type === 'userMessage') {
      const prompt = (item.content ?? []).filter(part => part.type === 'text')
        .map(part => userMessageText(part.text ?? '')).join('\n\n');
      const heartbeat = parseHeartbeatPrompt(prompt);
      messages.push({ itemId: item.id, prompt: excerpt(heartbeat ? heartbeat.instructions : prompt) || '\u56fe\u7247', reply: '' });
    } else if (item.type === 'agentMessage' && item.phase !== 'commentary' && item.phase !== 'partial_answer') {
      const message = messages.at(-1);
      if (message) message.reply = excerpt(heartbeatResponseText(item.text ?? ''));
    }
  }
  return messages;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 360);
}
