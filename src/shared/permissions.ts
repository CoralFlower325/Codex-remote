export interface PermissionProfile {
  id: string;
  description?: string | null;
  allowed: boolean;
}

export interface PermissionSettings {
  activePermissionProfile?: { id: string } | null;
  sandboxPolicy?: { type: string };
  sandbox?: { type: string };
  default_permissions?: string | null;
  sandbox_mode?: string | null;
}

export function permissionProfileId(settings: PermissionSettings): string | null {
  if (settings.activePermissionProfile?.id) return settings.activePermissionProfile.id;
  if (settings.default_permissions) return settings.default_permissions;
  switch (settings.sandboxPolicy?.type ?? settings.sandbox?.type ?? settings.sandbox_mode) {
    case 'readOnly':
    case 'read-only': return ':read-only';
    case 'workspaceWrite':
    case 'workspace-write': return ':workspace';
    case 'dangerFullAccess':
    case 'danger-full-access': return ':danger-full-access';
    default: return null;
  }
}

export function permissionLabel(id: string | null | undefined): string {
  switch (id) {
    case ':read-only': return '只读';
    case ':workspace': return '默认权限';
    case ':danger-full-access': return '完全访问';
    default: return id || '访问权限';
  }
}

export function permissionProfileUpdate(id: string) {
  return {
    permissions: id,
    ...([':read-only', ':workspace', ':danger-full-access'].includes(id)
      ? { approvalPolicy: id === ':danger-full-access' ? 'never' : 'on-request', approvalsReviewer: 'user' }
      : {})
  };
}

export function permissionDescription(id: string | null | undefined, nativeDescription?: string | null): string {
  if (id !== ':danger-full-access' && nativeDescription?.trim()) return nativeDescription;
  switch (id) {
    case ':read-only': return '仅允许读取文件；写入、命令和网络操作受原生权限限制。';
    case ':workspace': return '允许在工作区内修改文件，工作区外的受限操作需要批准。';
    case ':danger-full-access': return '对应 danger-full-access，approvalPolicy 为 never：允许访问主机文件和执行命令，不再逐次请求批准。';
    default: return '此聊天使用主机提供的权限配置。';
  }
}
