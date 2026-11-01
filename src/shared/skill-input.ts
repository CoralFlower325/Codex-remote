export interface SkillReference { name: string; path: string }

export function skillMention({ name, path }: SkillReference): string {
  return `[$${name}](${path})`;
}

export function withSkillMentions(text: string, skills: SkillReference[]): string {
  const mentions = [...new Set(skills.map(skillMention))].filter(mention => !text.includes(mention));
  return [...mentions, text.trim()].filter(Boolean).join(' ');
}

export function withoutLeadingSkillMentions(text: string, skills: SkillReference[]): string {
  const mentions = skills.map(skillMention);
  for (;;) {
    const mention = mentions.find(mention => text.startsWith(mention));
    if (!mention) return text;
    text = text.slice(mention.length).trimStart();
  }
}
