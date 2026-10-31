import { api } from './api';
import { originUpdateSource, refreshAppVersion, type UpdateStage } from './app-update';
import type { BackendUpdateCheck, BackendUpdateOperation, BackendUpdateRequest, BackendUpdateStatus } from '../shared/backend-update';

const pendingKey = 'remote-backend-update';
export const backendUpdateApi = {
  status: (signal?: AbortSignal) => api<BackendUpdateStatus>('/api/remote-update', {
    cache: 'no-store', timeoutMs: 8000, ...(signal ? { signal } : {})
  }),
  check: (signal?: AbortSignal) => api<BackendUpdateCheck>('/api/remote-update/check', {
    method: 'POST', body: '{}', timeoutMs: 30_000, ...(signal ? { signal } : {})
  }),
  install: (request: BackendUpdateRequest, signal?: AbortSignal) => api<BackendUpdateOperation>('/api/remote-update/install', {
    method: 'POST', body: JSON.stringify(request), timeoutMs: 60_000, ...(signal ? { signal } : {})
  })
};
export function pendingBackendUpdate(): string | null {
  try { return sessionStorage.getItem(pendingKey); } catch { return null; }
}
export function rememberBackendUpdate(id: string | null) {
  try {
    if (id) sessionStorage.setItem(pendingKey, id);
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The server's persisted progress remains available. */ }
}
export function refreshBackendClient(version: string, onStage: (stage: UpdateStage) => void, signal?: AbortSignal) {
  return refreshAppVersion({ source: originUpdateSource, expectedVersion: version, receipt: false,
    onStage, ...(signal ? { signal } : {}) });
}
