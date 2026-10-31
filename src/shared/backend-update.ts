export interface BackendUpdateProgress {
  percent: number;
  step: string;
  title: string;
  detail: string;
  startedAt: number;
  stepStartedAt: number;
  endedAt: number | null;
  status: string;
}
export interface BackendUpdateOperation {
  id: string;
  fromVersion: string;
  version: string;
  status: 'running' | 'completed' | 'failed' | 'recovered' | 'recovery-failed' | 'interrupted';
  updatedAt: number;
  progress: BackendUpdateProgress | null;
  message?: string;
}
export interface BackendUpdateStatus {
  currentVersion: string;
  platform: string;
  arch: string;
  supported: boolean;
  operation: BackendUpdateOperation | null;
}
export interface BackendUpdateCheck extends BackendUpdateStatus {
  available: boolean;
  latestVersion?: string;
  canUpdate?: boolean;
  reason?: string;
  token?: string;
  recoveryRequired?: boolean;
}
export interface BackendUpdateRequest {
  id: string;
  version: string;
  token: string;
  recover?: boolean;
}
