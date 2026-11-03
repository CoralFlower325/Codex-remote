import type { ProjectInfo, Thread } from './types';

export const projectRootsStorageKey = 'workspace-project-roots-v1';
export type ProjectRootPreferences = Record<string, string>;

export function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function selectedProjectRoot(project: ProjectInfo | undefined, preferences: ProjectRootPreferences): string | undefined {
  if (!project) return undefined;
  const remembered = Object.hasOwn(preferences, project.id) ? preferences[project.id] : undefined;
  return project.roots.find(root => remembered && pathKey(root.path) === pathKey(remembered))?.path ?? project.roots[0]?.path;
}

export function threadProject(thread: Thread, projects: ProjectInfo[]): ProjectInfo | undefined {
  const explicit = projects.find(project => project.id === thread.projectId);
  if (explicit) return explicit;
  const cwd = pathKey(thread.cwd);
  return projects.flatMap(project => project.roots.map(root => ({ project, root: pathKey(root.path) })))
    .filter(({ root }) => cwd === root || cwd.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0]?.project;
}

export function readProjectRoots(storage?: Pick<Storage, 'getItem'>): ProjectRootPreferences {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(projectRootsStorageKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, path]) =>
      key.length <= 1024 && typeof path === 'string' && path.length <= 32_768).slice(-200));
  } catch { return {}; }
}

export function rememberProjectRoot(storage: Pick<Storage, 'setItem'> | undefined, preferences: ProjectRootPreferences,
  project: ProjectInfo, root: string): ProjectRootPreferences {
  if (!project.roots.some(entry => entry.path === root)) throw new Error('请选择项目中的有效根目录。');
  const next = Object.fromEntries([...Object.entries(preferences).filter(([id]) => id !== project.id), [project.id, root]].slice(-200));
  try { (storage ?? localStorage).setItem(projectRootsStorageKey, JSON.stringify(next)); } catch { /* Keep selection usable without storage. */ }
  return next;
}
