import { parseQuestionReplies } from './async-user-input.js';
import { skillMention } from './skill-input.js';

export function userMessageDisplayText(content: Array<{ type: string; text?: string; name?: string; path?: string }>): string {
  const text = content.filter(part => part.type === 'text').map(part => userMessageText(part.text ?? ''))
    .filter(Boolean).join('\n\n');
  const skills = content.filter(part => part.type === 'skill' && part.name && part.path);
  let rest = text, mentions = '';
  // Only project the native leading mentions; user prose and code remain literal.
  while (rest) {
    const skill = skills.find(skill => rest.startsWith(skillMention({ name: skill.name!, path: skill.path! })));
    const match = /^\[\$([^\]\r\n]+)\]\((?:[^()\r\n]|\([^()\r\n]*\))*[\\/]SKILL\.md\)/.exec(rest);
    const reference = skill ? skillMention({ name: skill.name!, path: skill.path! }) : match?.[0];
    if (!reference) break;
    mentions += `$${skill?.name ?? match![1]}`;
    rest = rest.slice(reference.length);
    const space = /^\s+/.exec(rest)?.[0] ?? '';
    mentions += space;
    rest = rest.slice(space.length);
  }
  return mentions + rest || skills.map(skill => `$${skill.name}`).join(' ');
}

export function userMessageText(text: string): string {
  if (/^\s*# (?:Files|Applications) mentioned by the user:[ \t]*\r?\n/.test(text)) {
    const request = /^## My request:[ \t]*\r?\n/m.exec(text);
    if (request) text = text.slice(request.index + request[0].length).replace(/\r?\n$/, '');
  }
  const replies = parseQuestionReplies(text);
  return replies.length ? replies.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n') : text;
}
