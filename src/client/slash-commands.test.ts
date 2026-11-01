import { describe, expect, it } from 'vitest';
import { collaborationMode, findSlashCommand, parseSlashQuery, slashOptions, turnInput } from './slash-commands';
import type { SkillInfo } from './types';

const skills: SkillInfo[] = [
  { name: 'design', path: '/skills/design/SKILL.md', description: 'Design UI', enabled: true },
  { name: 'design', path: '/plugins/design/SKILL.md', description: 'Design a document', enabled: true },
  { name: 'disabled', path: '/skills/disabled/SKILL.md', description: 'Disabled skill', enabled: false },
  { name: 'review', path: '/skills/review/SKILL.md', description: 'Skill sharing a built-in name', enabled: true }
];
const context = { hasThread: true, running: false };

describe('slash command routing', () => {
  it('parses commands and preserves arguments without capturing paths or multiline prompts', () => {
    expect(parseSlashQuery('/')).toEqual({ name: '', argument: '' });
    expect(parseSlashQuery('/rename  Release plan')).toEqual({ name: 'rename', argument: 'Release plan' });
    expect(parseSlashQuery('/design inspect layout')).toEqual({ name: 'design', argument: 'inspect layout' });
    for (const text of ['/usr/local/bin', '//model', 'https://example.com', 'Explain /model', '/model\nplease', 'C:\\project']) {
      expect(parseSlashQuery(text), text).toBeNull();
    }
  });

  it('resolves aliases and ranks exact command names before substring matches', () => {
    expect(findSlashCommand('APPROVALS')?.id).toBe('permissions');
    expect(findSlashCommand('clear')?.id).toBe('new');
    expect(findSlashCommand('unknown')).toBeUndefined();
    const options = slashOptions({ name: 'review', argument: '' }, skills, context);
    expect(options[0]?.command).toBe('review');
    expect(options.some((entry) => entry.skill)).toBe(false);
  });

  it('filters native skills, preserves same-name skills with different paths and exposes collisions in /skills', () => {
    const options = slashOptions({ name: 'design', argument: '' }, skills, context);
    expect(options.filter((entry) => entry.skill)).toHaveLength(2);
    const all = slashOptions({ name: 'skills', argument: '' }, skills, { ...context, skillsOnly: true });
    expect(all).toHaveLength(3);
    expect(all.every((entry) => entry.skill?.enabled)).toBe(true);
    const filtered = slashOptions({ name: 'skills', argument: 'document' }, skills, { ...context, skillsOnly: true });
    expect(filtered.map((entry) => entry.skill?.path)).toEqual(['/plugins/design/SKILL.md']);
  });

  it('disables persisted-history and idle-only commands in the appropriate state', () => {
    const home = slashOptions({ name: '', argument: '' }, [], { hasThread: false, running: false });
    expect(home.find((entry) => entry.command === 'compact')?.disabledReason).toBeTruthy();
    expect(home.find((entry) => entry.command === 'model')?.disabledReason).toBeUndefined();
    const running = slashOptions({ name: '', argument: '' }, [], { hasThread: true, running: true });
    for (const command of ['compact', 'review', 'fork', 'plan']) {
      expect(running.find((entry) => entry.command === command)?.disabledReason).toBeTruthy();
    }
    expect(running.find((entry) => entry.command === 'status')?.disabledReason).toBeUndefined();
  });

  it('builds native skill, text and image input for both new turns and steering', () => {
    expect(turnInput('  Inspect layout  ', [{ url: 'data:image/png;base64,example' }], [skills[0]!])).toEqual([
      { type: 'text', text: '[$design](/skills/design/SKILL.md) Inspect layout', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,example' },
      { type: 'skill', name: 'design', path: '/skills/design/SKILL.md' }
    ]);
    expect(turnInput('', [], [skills[0]!])).toEqual([
      { type: 'text', text: '[$design](/skills/design/SKILL.md)', text_elements: [] },
      { type: 'skill', name: 'design', path: '/skills/design/SKILL.md' }
    ]);
  });

  it('retains a visible native mention per selected skill without duplicating one already in the prompt', () => {
    const prompt = '[$design](/skills/design/SKILL.md) Inspect both';
    expect(turnInput(prompt, [], skills.slice(0, 2))).toEqual([
      { type: 'text', text: `[$design](/plugins/design/SKILL.md) ${prompt}`, text_elements: [] },
      { type: 'skill', name: 'design', path: '/skills/design/SKILL.md' },
      { type: 'skill', name: 'design', path: '/plugins/design/SKILL.md' }
    ]);
    expect(turnInput('Plain **text**', [])).toEqual([{ type: 'text', text: 'Plain **text**', text_elements: [] }]);
    expect(turnInput('', [{ url: 'image' }])).toEqual([{ type: 'image', url: 'image' }]);
  });

  it('uses native collaboration settings with the current provider model and reasoning level', () => {
    expect(collaborationMode('plan', 'provider-model', 'max')).toEqual({
      mode: 'plan', settings: { model: 'provider-model', reasoning_effort: 'max', developer_instructions: null }
    });
    expect(collaborationMode('default', 'provider-model', '').settings.reasoning_effort).toBeNull();
  });
});
