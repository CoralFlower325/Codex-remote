import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HttpError } from '../api';
import { backendUpdateApi, pendingBackendUpdate, rememberBackendUpdate, refreshBackendClient } from '../backend-update';
import { updateStageLabels } from '../app-update';
import type { BackendUpdateCheck, BackendUpdateOperation, BackendUpdateStatus } from '../../shared/backend-update';
import './notification-settings.css';
import './backend-update.css';

export function BackendUpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<BackendUpdateStatus | null>(null);
  const [offer, setOffer] = useState<BackendUpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [monitor, setMonitor] = useState(() => Boolean(pendingBackendUpdate()));
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [frontend, setFrontend] = useState('');
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const request = useRef<AbortController | null>(null);
  const refreshing = useRef(false);
  const operation = snapshot?.operation;
  const running = monitor || operation?.status === 'running';
  const progress = operation?.progress;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!running || !open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, open]);

  const refresh = useCallback(async (value: BackendUpdateOperation, signal: AbortSignal) => {
    if (refreshing.current) return;
    refreshing.current = true;
    setRefreshNeeded(false); setError('');
    try {
      setFrontend('正在更新网页版本…');
      await refreshBackendClient(value.version, stage => setFrontend(updateStageLabels[stage]), signal);
      rememberBackendUpdate(null);
    } catch (failure) {
      if (!signal.aborted) {
        setError(failure instanceof Error ? failure.message : '网页更新未完成，请重试。');
        setRefreshNeeded(true);
      }
    } finally {
      if (!signal.aborted) setFrontend('');
      refreshing.current = false;
    }
  }, []);

  const check = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    try {
      const status = await backendUpdateApi.status(controller.signal);
      setSnapshot(status);
      if (status.operation?.status === 'running') { setMonitor(true); return; }
      const value = await backendUpdateApi.check(controller.signal);
      setSnapshot(value); setOffer(value); setOffline(false);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof HttpError && failure.status === 404
        ? '此后端尚不支持网页更新，请先在本机更新一次 Remote。'
        : failure instanceof Error ? failure.message : '检查未完成，请重试。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }, []);
  useEffect(() => { if (open && !monitor) void check(); }, [open, check]); // Opening is an explicit check.

  useEffect(() => {
    if (!monitor) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    let stopped = false;
    const beganAt = Date.now();
    const read = async () => {
      if (pending || stopped || controller.signal.aborted) return;
      clearTimeout(timer); pending = true;
      try {
        const value = await backendUpdateApi.status(controller.signal);
        setSnapshot(value); setOffline(false);
        const item = value.operation;
        const expected = pendingBackendUpdate();
        if ((!item || expected && item.id !== expected) && Date.now() - beganAt > 30_000) {
          stopped = true; rememberBackendUpdate(null); setMonitor(false);
          setError('尚未找到本次更新任务，请重新检查。'); return;
        }
        if (item && item.status !== 'running') {
          if (expected && item.id !== expected) return;
          stopped = true; setBusy(false); setOffer(null);
          if (item.status === 'completed' && value.currentVersion === item.version) {
            await refresh(item, controller.signal);
          } else {
            rememberBackendUpdate(null);
            setError(item.message ?? (item.status === 'recovered' ? '已恢复旧版，请重新检查。' : '更新未完成，请重新检查。'));
          }
          setMonitor(false);
          return;
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof HttpError && failure.status === 401) {
          stopped = true; setMonitor(false); setError('登录已过期，请重新登录后查看更新进度。'); return;
        }
        setOffline(true);
      } finally {
        pending = false;
        if (!stopped && !controller.signal.aborted) timer = setTimeout(() => void read(), 1500);
      }
    };
    const recover = () => { if (document.visibilityState === 'visible') void read(); };
    void read();
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      stopped = true; controller.abort(); clearTimeout(timer);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [monitor, refresh]);

  async function install() {
    if (!offer?.token || !offer.latestVersion || request.current) return;
    const controller = new AbortController(), id = crypto.randomUUID();
    request.current = controller;
    setBusy(true); setStarting(true); setError(''); setRefreshNeeded(false);
    rememberBackendUpdate(id);
    try {
      const value = await backendUpdateApi.install({ id, token: offer.token, version: offer.latestVersion,
        recover: Boolean(offer.recoveryRequired) }, controller.signal);
      setSnapshot(current => current ? { ...current, operation: value } : current);
      setOffer(null); setMonitor(true);
    } catch (failure) {
      if (!controller.signal.aborted) {
        // Do not repeat an uncertain POST. Read the persisted job instead.
        try {
          const value = await backendUpdateApi.status(controller.signal);
          setSnapshot(value);
          if (value.operation?.id === id) { setMonitor(true); return; }
          rememberBackendUpdate(null);
          setError(failure instanceof Error ? failure.message : '更新启动未完成，请重新检查。');
          setOffer(null);
        } catch { setMonitor(true); setOffline(true); }
      }
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setStarting(false); }
      request.current = null;
    }
  }
  const elapsed = progress ? Math.max(0, Math.floor(((progress.endedAt ?? now) - progress.startedAt) / 1000)) : 0;
  const status = frontend || (running ? offline ? '后端正在重启或连接暂时中断，等待重新连接…'
    : progress?.title ?? '正在启动更新任务…' : busy ? starting ? '正在准备更新任务…' : '正在检查 Remote 更新…'
      : offer ? offer.available ? `发现新版本 ${offer.latestVersion}` : '后端已是最新版本，无需更新。'
        : operation?.status === 'completed' ? `已更新至 ${operation.version}` : '');
  if (!open) return null;
  return createPortal(<dialog ref={dialog} className="notification-settings backend-update-dialog"
    aria-labelledby="backend-update-title" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><h2 id="backend-update-title"><Download size={18} />Remote 更新</h2>
      <button type="button" className="icon-button" aria-label="关闭 Remote 更新" onClick={onClose}><X size={18} /></button></header>
    <div className="notification-settings-body">
      <dl className="backend-update-versions">
        <div><dt>后端版本</dt><dd>{snapshot?.currentVersion ?? '—'}</dd></div>
        <div><dt>运行系统</dt><dd>{snapshot ? snapshot.platform === 'win32' ? 'Windows'
          : snapshot.platform === 'darwin' ? 'macOS · Apple Silicon' : snapshot.platform : '—'}</dd></div>
      </dl>
      {running && <div className="backend-update-progress">
        <div className="backend-update-progress-label" aria-live="polite"><span>{progress?.title ?? '准备更新'}</span>
          <span>{progress?.percent ?? 0}%</span></div>
        <progress max={100} value={progress?.percent ?? 0} aria-label="Remote 更新进度" />
        <p>{offline ? '等待后端重新连接，已完成的进度保留。' : progress?.detail ?? '正在准备独立更新任务。'}</p>
        {progress && <small>已用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</small>}
      </div>}
      <div className="notification-feedback" role="status" aria-live="polite">
        {status && (!running || offline || frontend || !progress) && <p>{status}</p>}
        {error && <p className="backend-update-error">{error}</p>}
        {!running && offer?.reason && <p>{offer.reason}</p>}
      </div>
      {!running && !frontend && <button type="button" className="notification-enable" disabled={busy ||
        Boolean(offer && !offer.canUpdate && offer.available)}
        onClick={() => {
          if (refreshNeeded && operation) {
            const controller = new AbortController(); request.current = controller;
            void refresh(operation, controller.signal).finally(() => { request.current = null; });
          } else if (offer?.canUpdate && (offer.available || offer.recoveryRequired)) void install();
          else void check();
        }}>
        {busy ? <LoaderCircle size={18} className="spin" /> : offer?.available ? <Download size={18} /> : <RefreshCw size={18} />}
        <span>{busy ? starting ? '正在准备更新…' : '正在检查…' : refreshNeeded ? '重试刷新网页' : offer?.recoveryRequired ? '恢复旧版'
          : offer?.available ? `更新至 ${offer.latestVersion}` : '检查 Remote 更新'}</span>
      </button>}
    </div>
  </dialog>, document.body);
}
