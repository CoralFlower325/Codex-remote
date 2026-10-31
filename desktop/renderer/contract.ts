export type PublicEntry = { configured: boolean; reachable: boolean; state: string; detail: string };
export type Status = {
  root: string; version: string; localUrl: string; publicUrl: string; checkedAt: number;
  state: 'healthy' | 'degraded' | 'stopped' | 'conflict' | 'unowned';
  service: { running: boolean; enabled: boolean; installed: boolean };
  backend: { reachable: boolean; ready: boolean; ms: number }; desktop: boolean; passwordConfigured: boolean;
  diagnostics: string[]; tunnel: { managed: boolean; ready: boolean }; publicEntry: PublicEntry;
};
export type State = {
  root: string; version: string; platform: string; packaged: boolean; launchAtLogin: boolean;
  recoveryRequired: boolean;
  status: Status | null; busy: string; error: string; healthError: string; result: string;
  release: { available: boolean; version: string; notes: string } | null;
  events: { time: number; message: string }[];
  installations: { root: string; version: string; source: string }[];
  security: { supported: boolean; passwordConfigured?: boolean; legacyDevicesPossible?: boolean; deviceCount?: number;
    devices: { id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number }[] } | null;
  connectionReport: (PublicEntry & { checkedAt: number }) | null;
  logs: { kind: string; text: string } | null;
  updateProgress: {
    percent: number; step: string; title: string; detail: string; startedAt: number;
    stepStartedAt: number; lastOutputAt: number | null; endedAt: number | null;
    status: 'running' | 'recovering' | 'completed' | 'recovered' | 'failed' | 'recovery-failed';
    logs: { time: number; message: string }[];
  } | null;
};
export type Result = { ok: boolean; value?: State; error?: string };
export type AuthRequest = { action: 'list' | 'password' | 'revoke' | 'revoke-all'; id?: string; password?: string; confirm?: string };
export interface Bridge {
  get(): Promise<Result>; refresh(): Promise<Result>; dismiss(): Promise<Result>; choose(): Promise<Result>;
  detect(): Promise<Result>; select(directory: string): Promise<Result>;
  action(action: string): Promise<Result>; open(): Promise<Result>; folder(): Promise<Result>;
  check(): Promise<Result>; update(): Promise<Result>; recover(): Promise<Result>; login(value: boolean): Promise<Result>;
  diagnose(): Promise<Result>; repair(target: string): Promise<Result>; logs(kind: string): Promise<Result>;
  security(request: AuthRequest): Promise<Result>;
  quit(): Promise<Result>; subscribe(listener: (state: State) => void): () => void;
}
declare global { interface Window { manager: Bridge } }
