import { ArrowDownToLine, ChevronDown, FolderOpen, RefreshCw, RotateCw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Result, State } from './contract';

function bytes(value: number) {
  return `${(Math.max(0, value) / 1024 / 1024).toFixed(1)} MB`;
}

export function ManagerUpdate({ state, disabled, perform }: {
  state: State; disabled: boolean; perform: (fn: () => Promise<Result>) => Promise<void>;
}) {
  const update = state.managerUpdate;
  const downloading = update?.status === 'downloading';
  const downloaded = update?.status === 'downloaded';
  const offered = update?.status === 'available' || (update?.status === 'error' && Boolean(update.version));
  return <section className="manager-updates" aria-label="管理器更新">
    <div className="update-heading">
      <div><h3>管理器</h3><p>当前版本 {state.version}</p></div>
      <button disabled={disabled || downloaded || update?.status === 'installing'}
        onClick={() => void perform(window.manager.managerCheck)}>
        <RefreshCw size={14} />检查管理器
      </button>
    </div>
    {update?.detail && <p className="detail manager-update-status" role="status">{update.detail}</p>}
    {update?.error && <p className="message error" role="alert">{update.error}</p>}
    {update?.blocked && <p className="detail manager-update-limit">{update.blocked}</p>}
    {downloading && <div className="manager-download">
      <div className="progress-heading"><span className="detail">下载安装包</span>
        <span className="percentage">{update.percent === null ? '等待数据' : `${update.percent}%`}</span></div>
      <progress aria-label="管理器下载进度" max="100" value={update.percent ?? undefined} />
      <div className="download-meta"><p className="meta">{bytes(update.transferred)} / {bytes(update.total)}
        {update.bytesPerSecond > 0 && ` · ${bytes(update.bytesPerSecond)}/秒`}</p>
        <button className="text-button" onClick={() => { void window.manager.managerCancel(); }}><X size={13} />取消下载</button>
      </div>
    </div>}
    {update && (offered || downloaded || downloading) && update.notes &&
      <details className="manager-release-notes"><summary><span>管理器 {update.version} 更新摘要</span><ChevronDown size={14} /></summary>
        <div className="notes"><ReactMarkdown components={{
          a: ({ children }) => <span>{children}</span>, img: () => null
        }}>{update.notes}</ReactMarkdown></div>
      </details>}
    {(offered || downloaded || update?.backup) && <div className="inline-actions">
      {offered && <button className="primary" disabled={disabled}
        onClick={() => void perform(update?.blocked ? window.manager.managerInstaller : window.manager.managerDownload)}>
        <ArrowDownToLine size={14} />{update?.blocked ? '下载安装包' : '下载管理器更新'}
      </button>}
      {downloaded && <button className="primary" disabled={disabled}
        onClick={() => void perform(window.manager.managerInstall)}><RotateCw size={14} />安装并重新打开</button>}
      {update?.backup && <button disabled={disabled} onClick={() => void perform(window.manager.managerBackups)}>
        <FolderOpen size={14} />打开更新备份
      </button>}
    </div>}
  </section>;
}
