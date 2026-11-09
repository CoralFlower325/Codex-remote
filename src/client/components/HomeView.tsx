import type { ComposerCommandProps } from './Composer';
import { Composer } from './Composer';
import type { ConnectionView, DirectoryView, PermissionView } from '../remote-contracts';
import type { ComposerAttachment, ProjectInfo, SkillInfo } from '../types';
import type { ComposerInput } from '../composer-drafts';
import type { LayoutMode } from '../useResponsiveLayout';

export interface HomeViewProps {
  layout: LayoutMode;
  connection: Pick<ConnectionView, 'connected'>;
  directory: Pick<DirectoryView, 'models' | 'projects'>;
  permissions: Pick<PermissionView, 'permissionProfiles'>;
  selectedProjectId: string;
  model: string;
  effort: string;
  permissionsValue: string;
  cwdChanging: boolean;
  onPermissionsChange: (permissions: string) => Promise<void>;
  focusRequest: number;
  onProjectChange: (projectId: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onSubmit: (text: string, attachments: ComposerAttachment[], skills: SkillInfo[],
    submitted?: ComposerInput) => Promise<void>;
  onError: (error: unknown) => void;
  commandProps: ComposerCommandProps;
}

export function HomeView({
  layout,
  connection,
  directory,
  permissions,
  selectedProjectId,
  model,
  effort,
  permissionsValue,
  cwdChanging,
  onPermissionsChange,
  focusRequest,
  onProjectChange,
  onModelChange,
  onEffortChange,
  onSubmit,
  onError,
  commandProps
}: HomeViewProps) {
  return (
    <div className={`home-view home-view--${layout}`}>
      <div className="home-hero">
        <div className="home-symbol" aria-hidden="true">
          <img src="/codex-mark.svg" width={48} height={48} alt="" />
        </div>
        <h1>{projectTitle(directory.projects, selectedProjectId)}</h1>
      </div>
      <div className="home-composer-dock">
        <Composer
          {...commandProps}
          variant="home"
          disabled={!connection.connected || cwdChanging}
          layout={layout}
          model={model}
          effort={effort}
          permissions={permissionsValue}
          permissionProfiles={permissions.permissionProfiles}
          onPermissionsChange={onPermissionsChange}
          models={directory.models}
          projects={directory.projects}
          selectedProjectId={selectedProjectId}
          focusRequest={focusRequest}
          onProjectChange={onProjectChange}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onSubmit={onSubmit}
          onError={onError}
        />
      </div>
    </div>
  );
}

function projectTitle(projects: ProjectInfo[], selectedProjectId: string): string {
  if (!selectedProjectId) return '有什么可以帮忙？';
  return `在 ${projects.find(project => project.id === selectedProjectId)?.name ?? '项目'} 中需要什么帮助？`;
}
