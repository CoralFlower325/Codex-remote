export const appUpdateSettings = {
  script: '/sw.js', manifest: '/version.json', scope: '/',
  timeoutMs: 120_000, messageTimeoutMs: 5_000
} as const;

import type { ReleaseNote } from '../shared/release-notes';

export interface AppBuild { version: string; buildId: string; releases?: ReleaseNote[] }
export interface AppUpdateSource { manifest: string; script: string }
export const originUpdateSource: AppUpdateSource = {
  manifest: '/remote-client/version.json', script: '/remote-client/sw.js'
};
export function pageUpdateSource(): AppUpdateSource {
  return typeof document !== 'undefined' && document.querySelector('script[src*="/remote-client/assets/"]')
    ? originUpdateSource : appUpdateSettings;
}
export type UpdateStage = 'checking' | 'current' | 'downloading' | 'activating' | 'reloading';
export const updateStageLabels: Record<UpdateStage, string> = {
  checking: '正在检查最新版本…', current: '已是最新版本，无需刷新。',
  downloading: '正在下载新版本，请保持页面打开…',
  activating: '正在启用新版本…', reloading: '更新完成，正在刷新页面…'
};

function readBuild(value: unknown): AppBuild {
  if (!value || typeof value !== 'object') throw new Error('版本信息无效，请稍后重试。');
  const { version, buildId } = value as Partial<AppBuild>;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || version.length > 64 ||
    typeof buildId !== 'string' || !/^assets\/[\w-]+\.js$/.test(buildId) || buildId.length > 160) {
    throw new Error('版本信息无效，请稍后重试。');
  }
  const releases = (value as AppBuild).releases;
  return { version, buildId, ...(Array.isArray(releases) ? { releases: releases.slice(0, 32).flatMap(note =>
    note && typeof note.version === 'string' && /^\d+\.\d+\.\d+$/.test(note.version) &&
      Array.isArray(note.changes) ? [{
        version: note.version, changes: note.changes.filter((text): text is string =>
          typeof text === 'string' && text.length > 0 && text.length <= 500).slice(0, 16)
      }] : []) } : {}) };
}

export function currentPageBuild(): AppBuild | null {
  if (typeof document === 'undefined') return null;
  const script = [...document.querySelectorAll<HTMLScriptElement>('script[src]')].find(element =>
    /\/assets\/index-[\w-]+\.js(?:\?|$)/.test(element.src));
  return script ? { version: import.meta.env.VITE_APP_VERSION,
    buildId: new URL(script.src).pathname.replace(/^\/(?:remote-client\/)?/, '') } : null;
}

export function changesSince(build: AppBuild, currentVersion?: string): ReleaseNote[] {
  const notes = build.releases ?? [];
  const current = notes.findIndex(note => note.version === currentVersion);
  return (current <= 0 ? notes.filter(note => note.version === build.version) : notes.slice(0, current));
}

export async function checkAppVersion(signal?: AbortSignal, current = currentPageBuild(), source = pageUpdateSource()) {
  const response = await fetch(`${source.manifest}?check=${Date.now()}`, {
    cache: 'no-store', credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`版本检查失败（${response.status}），请稍后重试。`);
  const latest = readBuild(await response.json());
  if (!current && navigator.serviceWorker?.controller) {
    current = await workerBuild(navigator.serviceWorker.controller, signal ?? AbortSignal.timeout(5000));
  }
  return { current, latest, updateAvailable: !current || current.buildId !== latest.buildId || current.version !== latest.version };
}

const receiptKey = 'app-update-receipt';
export function takeUpdateReceipt(): AppBuild | null {
  try {
    const raw = sessionStorage.getItem(receiptKey);
    if (!raw) return null;
    const build = readBuild(JSON.parse(raw));
    if (build.version !== import.meta.env.VITE_APP_VERSION) return null;
    return build;
  } catch { return null; }
}
export function clearUpdateReceipt() {
  try { sessionStorage.removeItem(receiptKey); } catch { /* Optional notice only. */ }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('更新已取消。');
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return; }
    const abort = () => { reject(abortError(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function waitForInstalled(worker: ServiceWorker, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { worker.removeEventListener('statechange', check); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError(signal)); };
    const check = () => {
      if (worker.state === 'redundant') { cleanup(); reject(new Error('新版本下载未完成，请检查网络后重试。')); }
      else if (['installed', 'activated'].includes(worker.state)) { cleanup(); resolve(); }
    };
    worker.addEventListener('statechange', check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

function workerBuild(worker: ServiceWorker, signal: AbortSignal): Promise<AppBuild> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); channel.port1.close(); channel.port2.close(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const abort = () => fail(abortError(signal));
    const timer = setTimeout(() => fail(new Error('未能确认新版本，请稍后重试。')), appUpdateSettings.messageTimeoutMs);
    channel.port1.onmessage = event => {
      try { const build = readBuild(event.data); cleanup(); resolve(build); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { worker.postMessage({ type: 'codex-update:build' }, [channel.port2]); }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}

function waitForController(container: ServiceWorkerContainer, worker: ServiceWorker, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { container.removeEventListener('controllerchange', check); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError(signal)); };
    const check = () => { if (container.controller === worker) { cleanup(); resolve(); } };
    container.addEventListener('controllerchange', check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

interface UpdateOptions {
  signal?: AbortSignal;
  onStage: (stage: UpdateStage, build?: AppBuild) => void;
  returnToApp?: boolean;
  currentBuild?: AppBuild | null;
  expectedBuild?: AppBuild;
  expectedVersion?: string;
  source?: AppUpdateSource;
  receipt?: boolean;
}

/** Explicit user action: preserve private state and subscriptions, activate a fully cached build. */
export async function refreshAppVersion({ signal, onStage, returnToApp = false, currentBuild, expectedBuild,
  expectedVersion, source = pageUpdateSource(), receipt = true }: UpdateOptions): Promise<'current' | 'updated'> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error('更新超时，网络较慢，请稍后重试。')), appUpdateSettings.timeoutMs);
  const stage = (value: UpdateStage, build?: AppBuild) => {
    console.debug('[app-update] stage', { stage: value, version: build?.version, buildId: build?.buildId });
    onStage(value, build);
  };
  try {
    stage('checking');
    const check = await checkAppVersion(controller.signal, currentBuild === undefined ? currentPageBuild() : currentBuild, source);
    const build = check.latest;
    if (expectedVersion && build.version !== expectedVersion) throw new Error('后端与网页版本尚未一致，请稍后重试刷新。');
    if (!check.updateAvailable) { stage('current', build); return 'current'; }
    if (expectedBuild && (expectedBuild.version !== build.version || expectedBuild.buildId !== build.buildId)) {
      throw new Error('服务器版本正在变化，请重新检查更新摘要。');
    }
    if ('serviceWorker' in navigator) {
      stage('downloading', build);
      const registration = await abortable(navigator.serviceWorker.register(source.script, {
        scope: appUpdateSettings.scope, updateViaCache: 'none'
      }), controller.signal);
      await abortable(registration.update(), controller.signal);
      const worker = registration.waiting ?? registration.installing ?? registration.active;
      if (!worker) throw new Error('未找到可更新版本，请稍后重试。');
      await waitForInstalled(worker, controller.signal);
      const installed = await workerBuild(worker, controller.signal);
      if (installed.buildId !== build.buildId || installed.version !== build.version) {
        throw new Error('服务器版本正在变化，请稍后再检查一次。');
      }
      stage('activating', installed);
      const controlled = waitForController(navigator.serviceWorker, worker, controller.signal);
      try { if (worker.state === 'installed') worker.postMessage({ type: 'codex-update:activate' }); }
      catch (error) { controller.abort(error); }
      await controlled;
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    try { if (receipt) sessionStorage.setItem(receiptKey, JSON.stringify({
      ...build, releases: changesSince(build, check.current?.version)
    })); } catch { /* Updating remains available without session storage. */ }
    stage('reloading', build);
    if (source.script === originUpdateSource.script && !('serviceWorker' in navigator)) {
      location.replace(`/remote-client/${location.search ?? ''}${location.hash ?? ''}`);
    } else if (returnToApp) location.replace('/'); else location.reload();
    return 'updated';
  } catch (error) {
    const failure = controller.signal.aborted ? abortError(controller.signal) : error;
    console.warn('[app-update] failed', failure);
    throw failure;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
