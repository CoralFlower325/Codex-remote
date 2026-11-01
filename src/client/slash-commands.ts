import type { CollaborationMode, SkillInfo } from './types';
import { withSkillMentions } from '../shared/skill-input';
import { withDocumentReferences, type DocumentReference } from '../shared/document-input';

export const slashCommands = [
  { id: 'new', label: '新聊天', description: '开始一个新任务', aliases: ['clear'], needsThread: false, idleOnly: false },
  { id: 'model', label: '模型', description: '选择当前 Codex 提供的模型', aliases: [], needsThread: false, idleOnly: false },
  { id: 'reasoning', label: '推理强度', description: '选择模型支持的思考档位', aliases: [], needsThread: false, idleOnly: false },
  { id: 'permissions', label: '访问权限', description: '修改当前聊天的权限', aliases: ['approvals'], needsThread: false, idleOnly: false },
  { id: 'plan', label: '计划模式', description: '切换计划模式与默认模式', aliases: [], needsThread: false, idleOnly: true },
  { id: 'skills', label: '技能', description: '选择当前项目可用的技能', aliases: [], needsThread: false, idleOnly: false },
  { id: 'compact', label: '压缩上下文', description: '压缩当前聊天，保留摘要', aliases: [], needsThread: true, idleOnly: true },
  { id: 'review', label: '代码审查', description: '审查未提交修改、分支或提交', aliases: [], needsThread: true, idleOnly: true },
  { id: 'fork', label: '分叉聊天', description: '从当前记录创建独立聊天', aliases: [], needsThread: true, idleOnly: true },
  { id: 'rename', label: '重命名', description: '修改当前聊天的名称', aliases: [], needsThread: true, idleOnly: false },
  { id: 'diff', label: '查看变更', description: '查看已加载聊天中的文件差异', aliases: [], needsThread: true, idleOnly: false },
  { id: 'status', label: '状态', description: '查看连接、模型和上下文用量', aliases: [], needsThread: false, idleOnly: false },
  { id: 'mcp', label: 'MCP 服务器', description: '查看原生工具连接状态', aliases: [], needsThread: false, idleOnly: false },
  { id: 'help', label: '命令', description: '浏览可用命令', aliases: [], needsThread: false, idleOnly: false }
] as const;

export type SlashCommandId = typeof slashCommands[number]['id'];
export interface SlashQuery { name: string; argument: string }
export interface SlashOption {
  id: string;
  command?: SlashCommandId;
  skill?: SkillInfo;
  label: string;
  description: string;
  disabledReason?: string;
}

// A leading slash word is a command; paths, URLs and multiline text remain text.
export function parseSlashQuery(text: string): SlashQuery | null {
  const match = /^\/([\p{L}\p{N}_-]*)(?:[ \t]+([^\r\n]*))?$/u.exec(text);
  return match ? { name: match[1] ?? '', argument: match[2] ?? '' } : null;
}

export function findSlashCommand(name: string) {
  const normalized = name.toLowerCase();
  return slashCommands.find((command) =>
    command.id === normalized || (command.aliases as readonly string[]).includes(normalized)
  );
}

export function slashOptions(query: SlashQuery, skills: SkillInfo[], context: {
  hasThread: boolean; running: boolean; skillsOnly?: boolean;
}): SlashOption[] {
  const needle = query.name.toLocaleLowerCase();
  const commands: SlashOption[] = context.skillsOnly ? [] : slashCommands
    .filter((command) => [command.id, command.label, ...command.aliases].some((value) => value.toLocaleLowerCase().includes(needle)))
    .map((command) => ({
      id: `command:${command.id}`, command: command.id, label: `/${command.id}`, description: command.label,
      ...(command.needsThread && !context.hasThread ? { disabledReason: '先打开一个已保存的聊天' } :
        command.idleOnly && context.running ? { disabledReason: '请等待当前任务结束' } : {})
    }));
  const skillNeedle = context.skillsOnly ? query.argument.trim().toLocaleLowerCase() : needle;
  const skillOptions: SlashOption[] = skills.filter((skill) => skill.enabled &&
    (context.skillsOnly || !findSlashCommand(skill.name)) &&
    [skill.name, skill.description, skill.interface?.displayName].some((value) => value?.toLocaleLowerCase().includes(skillNeedle))
  ).map((skill) => ({
    id: `skill:${skill.path}`, skill, label: context.skillsOnly ? skill.interface?.displayName || skill.name : `/${skill.name}`,
    description: skill.interface?.shortDescription || skill.shortDescription || skill.description
  }));
  // Exact names take precedence over substring matches and similarly named skills.
  return [...commands, ...skillOptions].sort((a, b) =>
    Number(b.label.slice(1).toLocaleLowerCase() === needle) - Number(a.label.slice(1).toLocaleLowerCase() === needle)
  );
}

export function collaborationMode(mode: 'default' | 'plan', model: string, effort: string): CollaborationMode {
  return { mode, settings: { model, reasoning_effort: effort || null, developer_instructions: null } };
}

export function turnInput(text: string, attachments: Array<{ url: string; kind?: 'image' } |
  (DocumentReference & { kind: 'document'; status?: string })>, skills: SkillInfo[] = []) {
  const documents = attachments.filter((entry): entry is DocumentReference & { kind: 'document'; status?: string } =>
    entry.kind === 'document');
  if (documents.some(document => document.status || !document.path)) throw new Error('请等待附件上传完成，或移除上传失败的附件。');
  const prompt = withDocumentReferences(withSkillMentions(text, skills), documents);
  return [
    ...(prompt ? [{ type: 'text', text: prompt, text_elements: [] }] : []),
    ...attachments.flatMap(entry => entry.kind !== 'document' ? [{ type: 'image', url: entry.url }] : []),
    ...skills.map(({ name, path }) => ({ type: 'skill', name, path }))
  ];
}
