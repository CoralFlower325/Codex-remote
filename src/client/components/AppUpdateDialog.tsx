import { Download, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { changesSince, checkAppVersion, refreshAppVersion, updateStageLabels, type AppBuild } from '../app-update';
import './notification-settings.css';

export function AppUpdateDialog({ onClose, completed }: { onClose: () => void; completed?: AppBuild | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('更新将刷新页面。主会话文字草稿会保留；临时侧聊、待发图片和技能选择会清除。');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<AppBuild | null>(null);
  const [current, setCurrent] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => operation.current?.abort();
  }, []);
  async function refresh() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(null);
    try {
      if (!available) {
        setStatus(updateStageLabels.checking);
        const result = await checkAppVersion(controller.signal);
        setAvailable(result.updateAvailable ? result.latest : null);
        setCurrent(!result.updateAvailable);
        setStatus(result.updateAvailable ? `发现新版本 ${result.latest.version}` : updateStageLabels.current);
        return;
      }
      const outcome = await refreshAppVersion({ signal: controller.signal, expectedBuild: available, onStage: (stage, build) => {
        setStatus(`${updateStageLabels[stage]}${build ? `（${build.version}）` : ''}`);
      } });
      if (outcome === 'current') { setAvailable(null); setCurrent(true); }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setAvailable(null);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      operation.current = null;
    }
  }
  return createPortal(<dialog ref={dialog} className="notification-settings" aria-labelledby="app-update-title"
    onClose={onClose} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <header><h2 id="app-update-title"><Download size={18} />{completed ? '更新完成' : '刷新版本'}</h2>
      <button type="button" className="icon-button" aria-label="关闭版本更新" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="notification-settings-body">
      <p className="notification-intro">当前版本：{import.meta.env.VITE_APP_VERSION}</p>
      {(completed || available) && <div className="app-update-notes">
        <strong>{completed ? `已更新至 ${completed.version}` : `更新至 ${available!.version}`}</strong>
        {(completed ? completed.releases ?? [] : changesSince(available!, import.meta.env.VITE_APP_VERSION)).map(note =>
          <div key={note.version}><p>{note.version}</p><ul>{note.changes.map(text => <li key={text}>{text}</li>)}</ul></div>)}
        {!((completed ?? available)?.releases?.length) && <p>此版本未提供更新摘要。</p>}
      </div>}
      {!completed && <button type="button" className="notification-enable" disabled={busy} onClick={() => void refresh()}>
        {busy ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}<span>{busy ? '正在处理…'
          : available ? `更新至 ${available.version}` : current ? '重新检查' : '检查并更新版本'}</span>
      </button>}
      <div className="notification-feedback" role="status" aria-live="polite">
        {error ? <p className="notification-error">{error}</p> : !completed && <p>{status}</p>}
      </div>
    </div>
  </dialog>, document.body);
}
