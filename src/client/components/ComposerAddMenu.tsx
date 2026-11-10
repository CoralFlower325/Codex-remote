import {
  ChevronRight, FilePlus2, FileText, FileType2, FolderOpen, LayoutTemplate,
  ListTodo, LoaderCircle, PenTool, Presentation, RotateCw, Table2, Target
} from 'lucide-react';
import { useState } from 'react';
import type { SkillInfo } from '../types';

function pluginIcon(skill: SkillInfo) {
  const label = `${skill.interface?.displayName ?? ''} ${skill.name} ${skill.description}`.toLocaleLowerCase();
  if (/spreadsheet|表格|sheet|excel/.test(label)) return Table2;
  if (/presentation|slide|演示|powerpoint/.test(label)) return Presentation;
  if (/template|模板/.test(label)) return LayoutTemplate;
  if (/pdf/.test(label)) return FileType2;
  if (/document|文档|word/.test(label)) return FileText;
  return FileText;
}

export function ComposerAddMenu({
  skills, loading, error, mode, onChooseFile, onChooseFolder, onGoal, onPlan,
  onDrawing, onSkill, onRetrySkills
}: {
  skills: SkillInfo[];
  loading: boolean;
  error: string | null;
  mode: 'default' | 'plan';
  onChooseFile: () => void;
  onChooseFolder: () => void;
  onGoal: () => void;
  onPlan: () => void;
  onDrawing: () => void;
  onSkill: (skill: SkillInfo) => void;
  onRetrySkills: () => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const plugins = skills.filter(skill => skill.enabled).sort((left, right) =>
    (left.interface?.displayName || left.name).localeCompare(right.interface?.displayName || right.name, 'zh-CN'));

  return <div className="composer-add-menu">
    <div className="composer-add-section" role="group" aria-label="添加上下文">
      <div className="composer-add-section-label">添加</div>
      <button type="button" role="menuitem" className="composer-add-option" aria-expanded={filesOpen}
        onClick={() => setFilesOpen(value => !value)}>
        <FilePlus2 size={18} aria-hidden="true" />
        <span className="composer-add-option-copy">
          <span>文件和文件夹</span>
          <small>图片、PDF、Office、文本或代码</small>
        </span>
        <ChevronRight size={15} className={filesOpen ? 'is-open' : undefined} aria-hidden="true" />
      </button>
      {filesOpen && <div className="composer-add-submenu">
        <button type="button" role="menuitem" onClick={onChooseFile}><FilePlus2 size={16} />选择文件</button>
        <button type="button" role="menuitem" onClick={onChooseFolder}><FolderOpen size={16} />选择文件夹</button>
      </div>}
      <button type="button" role="menuitem" className="composer-add-option" onClick={onGoal}>
        <Target size={18} aria-hidden="true" />
        <span className="composer-add-option-copy">
          <span>目标</span>
          <small>设置要持续追求的目标</small>
        </span>
      </button>
      <button type="button" role="menuitem" className="composer-add-option" onClick={onPlan}>
        <ListTodo size={18} aria-hidden="true" />
        <span className="composer-add-option-copy">
          <span>{mode === 'plan' ? '退出计划模式' : '计划模式'}</span>
          <small>{mode === 'plan' ? '恢复默认协作模式' : '先规划，再执行'}</small>
        </span>
      </button>
      <button type="button" role="menuitem" className="composer-add-option" onClick={onDrawing}>
        <PenTool size={18} aria-hidden="true" />
        <span className="composer-add-option-copy">
          <span>绘图</span>
          <small>添加图片生成要求或可用技能</small>
        </span>
      </button>
    </div>
    <div className="composer-add-section composer-add-plugins" role="group" aria-label="插件">
      <div className="composer-add-section-label">插件 {loading &&
        <LoaderCircle size={13} className="spin" aria-label="正在读取插件" />}</div>
      {plugins.map(skill => {
        const Icon = pluginIcon(skill);
        return <button type="button" role="menuitem" className="composer-add-option" key={skill.path}
          onClick={() => onSkill(skill)} title={skill.description}>
          <Icon size={18} aria-hidden="true" />
          <span className="composer-add-option-copy">
            <span>{skill.interface?.displayName || skill.name}</span>
            <small>{skill.interface?.shortDescription || skill.shortDescription || skill.description}</small>
          </span>
        </button>;
      })}
      {!loading && plugins.length === 0 && !error &&
        <div className="composer-add-empty">当前目录没有可用的已启用插件。</div>}
      {error && <div className="composer-add-error" role="status">
        <span>{error}</span>
        <button type="button" className="icon-button icon-button--small" title="重新读取插件"
          aria-label="重新读取插件" onClick={onRetrySkills}><RotateCw size={14} /></button>
      </div>}
    </div>
  </div>;
}
