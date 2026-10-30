import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appUpdateSettings, changesSince, checkAppVersion, refreshAppVersion, type AppBuild, type UpdateStage } from './app-update';

const latest: AppBuild = { version: '0.1.8', buildId: 'assets/index-latest.js' };
class Port {
  peer: Port | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close = vi.fn();
  postMessage(data: unknown) { queueMicrotask(() => this.peer?.onmessage?.({ data })); }
}
class Channel {
  port1 = new Port(); port2 = new Port();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}
class Worker extends EventTarget {
  state: ServiceWorkerState = 'installed';
  build = latest;
  silent = false;
  activate = () => {};
  postMessage = vi.fn((message: { type: string }, ports?: Port[]) => {
    if (message.type === 'codex-update:build' && !this.silent) ports?.[0]?.postMessage(this.build);
    if (message.type === 'codex-update:activate') this.activate();
  });
  stateChange(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}

function fixture() {
  const worker = new Worker();
  const oldWorker = new Worker(); oldWorker.state = 'activated';
  oldWorker.build = { version: '0.1.7', buildId: 'assets/index-old.js' };
  const container = Object.assign(new EventTarget(), { controller: oldWorker, register: vi.fn() });
  const registration = {
    waiting: worker as Worker | null, installing: null as Worker | null, active: oldWorker,
    update: vi.fn(async () => {}), unregister: vi.fn()
  };
  container.register.mockResolvedValue(registration);
  worker.activate = () => {
    registration.waiting = null; registration.active = worker;
    worker.stateChange('activated'); container.controller = worker;
    container.dispatchEvent(new Event('controllerchange'));
  };
  const reload = vi.fn(); const replace = vi.fn();
  const fetcher = vi.fn(async () => new Response(JSON.stringify(latest)));
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('location', { reload, replace });
  vi.stubGlobal('fetch', fetcher);
  return { worker, oldWorker, registration, container, reload, replace, fetcher };
}

beforeEach(() => {
  vi.stubGlobal('MessageChannel', Channel);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('explicit version refresh', () => {
  it('checks network metadata, activates a matching cached build and reloads after control changes', async () => {
    const f = fixture();
    const stages: UpdateStage[] = [];
    await refreshAppVersion({ onStage: stage => stages.push(stage) });
    expect(f.fetcher).toHaveBeenCalledWith(expect.stringMatching(/^\/version.json\?check=/),
      expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
    expect(f.container.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    expect(f.registration.update).toHaveBeenCalledOnce();
    expect(f.worker.postMessage).toHaveBeenCalledWith({ type: 'codex-update:activate' });
    expect(stages).toEqual(['checking', 'downloading', 'activating', 'reloading']);
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.registration.unregister).not.toHaveBeenCalled();
  });

  it('waits for complete installation before activation', async () => {
    const f = fixture();
    f.registration.waiting = null; f.registration.installing = f.worker; f.worker.state = 'installing';
    const operation = refreshAppVersion({ onStage: () => {} });
    await settle();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.worker.postMessage).not.toHaveBeenCalled();
    f.registration.waiting = f.worker; f.registration.installing = null;
    f.worker.stateChange('installed');
    await operation;
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('waits for the requesting page to receive the new controller', async () => {
    const f = fixture();
    f.worker.activate = () => f.worker.stateChange('activated');
    const operation = refreshAppVersion({ onStage: () => {} });
    await settle();
    expect(f.reload).not.toHaveBeenCalled();
    f.container.controller = f.worker;
    f.container.dispatchEvent(new Event('controllerchange'));
    await operation;
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('leaves an already current page mounted without registering, activating or reloading', async () => {
    const f = fixture();
    f.registration.waiting = null; f.registration.active = f.worker;
    f.worker.state = 'activated'; f.container.controller = f.worker;
    const stages: UpdateStage[] = [];
    expect(await refreshAppVersion({ onStage: stage => stages.push(stage) })).toBe('current');
    expect(f.worker.postMessage).not.toHaveBeenCalledWith({ type: 'codex-update:activate' });
    expect(f.registration.unregister).not.toHaveBeenCalled();
    expect(stages).toEqual(['checking', 'current']);
    expect(f.container.register).not.toHaveBeenCalled();
    expect(f.registration.update).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
  });

  it('updates an old loaded shell even when another tab has already replaced its controller', async () => {
    const f = fixture();
    f.registration.waiting = null; f.registration.active = f.worker;
    f.worker.state = 'activated'; f.container.controller = f.worker;
    expect(await refreshAppVersion({ currentBuild: f.oldWorker.build, onStage: () => {} })).toBe('updated');
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it('recognizes a different build within the same package version', async () => {
    const f = fixture();
    expect((await checkAppVersion(undefined, { ...latest, buildId: 'assets/index-previous.js' })).updateAvailable).toBe(true);
    expect((await checkAppVersion(undefined, latest)).updateAvailable).toBe(false);
    expect(f.container.register).not.toHaveBeenCalled();
  });

  it('requires another review when the deployment changes after the displayed release summary', async () => {
    const f = fixture();
    await expect(refreshAppVersion({ currentBuild: f.oldWorker.build,
      expectedBuild: { ...latest, buildId: 'assets/index-reviewed.js' }, onStage: () => {} }))
      .rejects.toThrow('重新检查更新摘要');
    expect(f.container.register).not.toHaveBeenCalled(); expect(f.reload).not.toHaveBeenCalled();
  });

  it('does not navigate from recovery when the controlling build is already current', async () => {
    const f = fixture(); f.container.controller = f.worker;
    expect(await refreshAppVersion({ returnToApp: true, onStage: () => {} })).toBe('current');
    expect(f.replace).not.toHaveBeenCalled(); expect(f.reload).not.toHaveBeenCalled();
  });

  it('validates release summaries and includes only changes after the loaded version', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ ...latest, releases: [
      { version: '0.1.8', changes: ['Summary panel', 7, '', 'x'.repeat(501)] },
      { version: '0.1.7', changes: ['Mobile index'] },
      { version: '0.1.6', changes: ['Sidebar'] }, { version: 'bad', changes: ['discard'] }
    ] })));
    const { latest: build } = await checkAppVersion(undefined, f.oldWorker.build);
    expect(build.releases).toHaveLength(3);
    expect(changesSince(build, '0.1.6')).toEqual([
      { version: '0.1.8', changes: ['Summary panel'] }, { version: '0.1.7', changes: ['Mobile index'] }
    ]);
    expect(changesSince(build, '0.1.8')).toEqual([{ version: '0.1.8', changes: ['Summary panel'] }]);
  });

  it('returns to the application from the standalone recovery page', async () => {
    const f = fixture();
    await refreshAppVersion({ onStage: () => {}, returnToApp: true });
    expect(f.replace).toHaveBeenCalledExactlyOnceWith('/');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('refreshes directly when service workers are unavailable', async () => {
    const f = fixture(); vi.stubGlobal('navigator', {});
    await refreshAppVersion({ onStage: () => {} });
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.container.register).not.toHaveBeenCalled();
  });

  it('preserves the old version when metadata or network requests fail', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response('', { status: 503 }));
    await expect(refreshAppVersion({ onStage: () => {} })).rejects.toThrow('503');
    expect(f.registration.update).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it.each([{}, { version: 'bad', buildId: 'assets/index.js' },
    { version: '0.1.8', buildId: 'https://other.example/app.js' }])('rejects invalid build metadata %j', async metadata => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response(JSON.stringify(metadata)));
    await expect(refreshAppVersion({ onStage: () => {} })).rejects.toThrow('版本信息无效');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('does not activate a different server build', async () => {
    const f = fixture(); f.worker.build = f.oldWorker.build;
    await expect(refreshAppVersion({ onStage: () => {} })).rejects.toThrow('版本正在变化');
    expect(f.worker.postMessage).not.toHaveBeenCalledWith({ type: 'codex-update:activate' });
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('reports incomplete cache installation without replacing the working controller', async () => {
    const f = fixture();
    f.registration.waiting = null; f.registration.installing = f.worker; f.worker.state = 'installing';
    const operation = refreshAppVersion({ onStage: () => {} });
    const failure = expect(operation).rejects.toThrow('下载未完成');
    await settle(); f.worker.stateChange('redundant'); await failure;
    expect(f.container.controller).toBe(f.oldWorker);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('cancels an in-progress installation without a delayed reload', async () => {
    const f = fixture();
    f.registration.waiting = null; f.registration.installing = f.worker; f.worker.state = 'installing';
    const controller = new AbortController();
    const operation = refreshAppVersion({ signal: controller.signal, onStage: () => {} });
    const failure = expect(operation).rejects.toThrow('cancelled');
    await settle(); controller.abort(new Error('cancelled')); await failure;
    f.worker.stateChange('installed'); await settle();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('bounds a worker that cannot confirm its installed build', async () => {
    vi.useFakeTimers(); const f = fixture(); f.worker.silent = true;
    const failure = expect(refreshAppVersion({ onStage: () => {} })).rejects.toThrow('未能确认新版本');
    await settle(); await vi.advanceTimersByTimeAsync(appUpdateSettings.messageTimeoutMs + 1); await failure;
    expect(f.reload).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled installation and cleans up activation message failures', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.registration.waiting = null; f.registration.installing = f.worker; f.worker.state = 'installing';
    const failure = expect(refreshAppVersion({ onStage: () => {} })).rejects.toThrow('更新超时');
    await settle(); await vi.advanceTimersByTimeAsync(appUpdateSettings.timeoutMs + 1); await failure;
    expect(f.reload).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    f.registration.installing = null; f.registration.waiting = f.worker; f.worker.state = 'installed';
    f.worker.activate = () => { throw new Error('activation failed'); };
    await expect(refreshAppVersion({ onStage: () => {} })).rejects.toThrow('activation failed');
    expect(f.reload).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
