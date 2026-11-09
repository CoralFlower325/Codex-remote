import type { ModelInfo, ProjectInfo, Thread } from './types';
import { isTaskThread } from '../shared/thread-source';

export function layoutForViewport(width: number, height: number, coarsePointer = false): 'mobile' | 'desktop' {
  return width < 720 || (width < 980 && width / height < 1.18) ||
    (coarsePointer && width < 1024 && height < 540) ? 'mobile' : 'desktop';
}

export type TaskFilter = 'all' | 'active' | 'done';

export interface ProjectThreadGroup {
  project: ProjectInfo;
  threads: Thread[];
}

export interface SidebarGroups {
  projects: ProjectThreadGroup[];
  standalone: Thread[];
  total: number;
}

export interface ReasoningOption {
  value: string;
  label: string;
  description: string;
}

const REASONING_LABELS: Record<string, { label: string; description: string }> = {
  none: { label: '无', description: '不进行额外推理' },
  minimal: { label: '极低', description: '最短推理时间' },
  low: { label: '轻度', description: '较少推理，适合直接任务' },
  medium: { label: '中', description: '默认的平衡档位' },
  high: { label: '高', description: '适合复杂实现和排错' },
  xhigh: { label: '极高', description: '更充分地分析复杂任务' },
  max: { label: 'Max', description: '最高质量档位' },
  ultra: { label: 'Ultra', description: '最高推理预算与主动能力' }
};

export function dedupeThreads(threads: Thread[]): Thread[] {
  const byId = new Map<string, Thread>();
  for (const thread of threads) {
    const current = byId.get(thread.id);
    if (!current || thread.updatedAt >= current.updatedAt) byId.set(thread.id, thread);
  }
  return [...byId.values()].sort(sortByUpdatedAt);
}

export function buildSidebarGroups(
  threads: Thread[],
  projects: ProjectInfo[],
  query: string,
  filter: TaskFilter
): SidebarGroups {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleThreads = dedupeThreads(threads).filter((thread) => {
    if (!isTaskThread(thread)) return false;
    if (!matchesFilter(thread, filter)) return false;
    if (!normalizedQuery) return true;
    return [thread.name, thread.preview, thread.cwd]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });

  const projectBuckets = new Map<string, Thread[]>();
  const standalone: Thread[] = [];
  for (const thread of visibleThreads) {
    const project = findProjectForThread(thread, projects);
    if (!project) {
      standalone.push(thread);
      continue;
    }
    const bucket = projectBuckets.get(project.id) ?? [];
    bucket.push(thread);
    projectBuckets.set(project.id, bucket);
  }

  const projectGroups = [...projects]
    .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
    .map((project) => ({
      project,
      threads: (projectBuckets.get(project.id) ?? []).sort(sortByUpdatedAt)
    }))
    .filter((group) => {
      if (normalizedQuery) {
        return group.project.name.toLocaleLowerCase().includes(normalizedQuery) || group.threads.length > 0;
      }
      return filter === 'all' || group.threads.length > 0;
    });

  return {
    projects: projectGroups,
    standalone: standalone.sort(sortByUpdatedAt),
    total: visibleThreads.length
  };
}

export function findProjectForThread(thread: Thread, projects: ProjectInfo[]): ProjectInfo | null {
  if (thread.projectId) {
    const direct = projects.find((project) => project.id === thread.projectId);
    if (direct) return direct;
  }

  const cwd = normalizePath(thread.cwd);
  let best: { project: ProjectInfo; length: number } | null = null;
  for (const project of projects) {
    for (const root of project.roots ?? []) {
      const normalizedRoot = normalizePath(root.path);
      if (!normalizedRoot) continue;
      if (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`)) {
        if (!best || normalizedRoot.length > best.length) {
          best = { project, length: normalizedRoot.length };
        }
      }
    }
  }
  return best?.project ?? null;
}

export function reasoningOptionsForModel(model: ModelInfo | undefined): ReasoningOption[] {
  return (model?.supportedReasoningEfforts ?? []).map((entry) => {
    const fallback = REASONING_LABELS[entry.reasoningEffort] ?? {
      label: entry.reasoningEffort,
      description: ''
    };
    return {
      value: entry.reasoningEffort,
      label: fallback.label,
      description: entry.description || fallback.description
    };
  });
}

export function reasoningOptionsWithInherit(model: ModelInfo | undefined): ReasoningOption[] {
  return [
    { value: '', label: '默认', description: '使用 Desktop/全局配置中的模型默认推理强度。' },
    ...reasoningOptionsForModel(model)
  ];
}

export function resolveReasoningEffort(model: ModelInfo | undefined, candidate?: string | null): string {
  const options = reasoningOptionsForModel(model);
  if (candidate && options.some((option) => option.value === candidate)) return candidate;
  if (model?.defaultReasoningEffort && options.some((option) => option.value === model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return options[0]?.value ?? '';
}

export function reasoningLabel(model: ModelInfo | undefined, value: string | null | undefined): string {
  if (!value) return '默认';
  return reasoningOptionsForModel(model).find((option) => option.value === value)?.label ?? value;
}

export function findModelInfo(
  models: ModelInfo[],
  value: string | null | undefined,
  provider?: string | null
): ModelInfo | undefined {
  if (!value) return undefined;
  const matches = models.filter((model) => model.id === value || model.model === value);
  if (!provider) return matches.find((model) => model.isDefault) ?? matches[0];
  return matches.find((model) => {
    const modelProvider = model.modelProvider ?? model.provider;
    return !modelProvider || modelProvider === provider;
  }) ?? matches.find((model) => !(model.modelProvider ?? model.provider)) ?? matches[0];
}

export function modelDisplayName(models: ModelInfo[], value: string | null | undefined): string {
  if (!value) return '默认模型';
  const displayName = findModelInfo(models, value)?.displayName ?? value;
  if (value === 'gpt-6.1-sol') return '6.1 Sol';
  if (value === 'gpt-6-astra') return '6 Astra';
  return displayName;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
}

export function baseName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(timestamp * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function connectionLabel(status: string): string {
  switch (status) {
    case 'ready':
      return '已连接';
    case 'starting':
    case 'connecting':
      return '连接中';
    case 'restarting':
      return '重启中';
    case 'offline':
    case 'disconnected':
      return '未连接';
    default:
      return status;
  }
}

function matchesFilter(thread: Thread, filter: TaskFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return thread.status.type === 'active';
  return thread.status.type !== 'active';
}

function sortByUpdatedAt(left: Thread, right: Thread): number {
  return right.updatedAt - left.updatedAt;
}
