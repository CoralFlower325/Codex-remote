import { describe, expect, it } from 'vitest';
import { readProjectRoots, rememberProjectRoot, selectedProjectRoot, threadProject } from './project-roots';
import type { ProjectInfo, Thread } from './types';

const project: ProjectInfo = { id: 'demo', name: 'Demo', roots: [{ path: 'F:\\first' }, { path: 'F:\\second' }] };

describe('project root choices', () => {
  it('remembers a root across reload and falls back only when that root leaves the project', () => {
    let saved = '';
    const storage = { setItem: (_key: string, value: string) => { saved = value; }, getItem: () => saved };
    rememberProjectRoot(storage, {}, project, project.roots[1]!.path);
    const preferences = readProjectRoots(storage);
    expect(selectedProjectRoot(project, preferences)).toBe('F:\\second');
    expect(selectedProjectRoot({ ...project, roots: [project.roots[0]!] }, preferences)).toBe('F:\\first');
    expect(() => rememberProjectRoot(storage, preferences, project, 'F:\\outside')).toThrow();
  });

  it('uses explicit project membership or the closest containing root without rewriting a task cwd', () => {
    const nested: ProjectInfo = { id: 'nested', name: 'Nested', roots: [{ path: 'F:\\second\\nested' }] };
    const thread = { cwd: 'f:/second/nested/src', projectId: null } as Thread;
    expect(threadProject(thread, [project, nested])?.id).toBe('nested');
    expect(threadProject({ ...thread, projectId: 'demo' }, [project, nested])?.id).toBe('demo');
    expect(threadProject({ ...thread, cwd: 'F:\\second-other' }, [project])).toBeUndefined();
    expect(thread.cwd).toBe('f:/second/nested/src');
  });

  it('tolerates corrupt/unavailable preference storage and keeps projects independent', () => {
    expect(readProjectRoots({ getItem: () => 'bad json' })).toEqual({});
    expect(readProjectRoots({ getItem: () => '[]' })).toEqual({});
    expect(readProjectRoots({ getItem: () => '{"demo":123,"other":"/work"}' })).toEqual({ other: '/work' });
    const next = rememberProjectRoot({ setItem: () => { throw new Error('Storage disabled'); } },
      { other: '/work' }, project, 'F:\\second');
    expect(next).toEqual({ demo: 'F:\\second', other: '/work' });
    expect(selectedProjectRoot(project, { demo: 'f:/SECOND' })).toBe('F:\\second');
  });
});
