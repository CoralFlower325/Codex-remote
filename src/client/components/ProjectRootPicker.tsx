import { Folder, LoaderCircle } from 'lucide-react';
import type { ProjectInfo } from '../types';
import './project-root-picker.css';

export function ProjectRootPicker({ project, cwd, disabled, busy, onChange }: {
  project: ProjectInfo; cwd: string | undefined; disabled: boolean; busy: boolean;
  onChange: (path: string) => void;
}) {
  if (project.roots.length < 2) return null;
  const currentIsRoot = project.roots.some(root => root.path === cwd);
  return <div className="project-root-picker" aria-busy={busy}>
    {busy ? <LoaderCircle size={15} className="spin" /> : <Folder size={15} aria-hidden="true" />}
    <label htmlFor="project-root-path">根目录</label>
    <select id="project-root-path" aria-label="项目根目录" title={cwd} value={cwd ?? ''}
      disabled={disabled || busy} onChange={event => onChange(event.target.value)}>
      {!currentIsRoot && <option value={cwd ?? ''}>当前任务：{cwd || '未指定目录'}</option>}
      {project.roots.map(root => <option key={root.path} value={root.path}>{root.path}</option>)}
    </select>
  </div>;
}
