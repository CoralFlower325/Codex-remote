import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowUpToLine, ExternalLink, FolderOpen, Play, Power, RefreshCw, RotateCw, Square, X } from 'lucide-react';
import './style.css';

type Status = {
  root: string; version: string; localUrl: string; publicUrl: string; checkedAt: number;
  state: 'healthy' | 'degraded' | 'stopped' | 'conflict' | 'unowned';
  service: { running: boolean; enabled: boolean; installed: boolean };
  backend: { reachable: boolean; ms: number }; desktop: boolean; passwordConfigured: boolean;
  tunnel: { managed: boolean; ready: boolean };
};
type State = {
  root: string; version: string; platform: string; packaged: boolean; launchAtLogin: boolean;
  status: Status | null; busy: string; error: string; result: string;
  release: { available: boolean; version: string; notes: string } | null;
  events: { time: number; message: string }[];
};
type Result = { ok: boolean; value?: State; error?: string };
interface Bridge {
  get(): Promise<Result>; refresh(): Promise<Result>; choose(): Promise<Result>;
  action(action: string): Promise<Result>; open(): Promise<Result>; folder(): Promise<Result>;
  check(): Promise<Result>; update(): Promise<Result>; login(value: boolean): Promise<Result>;
  quit(): Promise<Result>; subscribe(listener: (state: State) => void): () => void;
}
declare global { interface Window { manager: Bridge } }
const initial: State = { root: '', version: '', platform: '', packaged: false, launchAtLogin: false,
  status: null, busy: '', error: '', result: '', release: null, events: [] };
const labels = { healthy: '运行正常', degraded: '需要检查', stopped: '已关闭',
  conflict: '安装目录冲突', unowned: '端口被占用' };
function App() {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState('status');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const unsubscribe = window.manager.subscribe(setState);
    void window.manager.get().then((result) => { if (result.value) setState(result.value); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);
  async function perform(fn: () => Promise<Result>) {
    if (pending || state.busy) return;
    setPending(true); setError('');
    try { const result = await fn(); if (!result.ok) setError(result.error || '操作失败'); }
    catch { setError('无法连接本机管理器。'); }
    finally { setPending(false); }
  }
  const status = state.status;
  const disabled = pending || Boolean(state.busy);
  const conflict = status && ['conflict', 'unowned'].includes(status.state);
  const stale = !status || now - status.checkedAt > 20_000;
  const canControl = Boolean(status) && !conflict && !state.error && !stale;
  const text = state.busy || (state.error ? '状态检测失败' : status ? labels[status.state] : state.root ? '正在检测' : '选择安装目录');
  const issue = error || state.error;
  return <main>
    <header>
      <img src="./app.png" width="32" height="32" alt="" />
      <div><h1>Codex Remote</h1><span>本机管理器 <small>v{state.version}</small></span></div>
      <button className="icon" title="刷新状态" aria-label="刷新状态" disabled={disabled}
        onClick={() => void perform(window.manager.refresh)}><RefreshCw size={17} /></button>
    </header>
    <section className="installation">
      <div><span className="caption">安装目录</span><span className="path" title={state.root}>{state.root || '尚未选择'}</span></div>
      <button className="icon" title="选择安装目录" aria-label="选择安装目录" disabled={disabled}
        onClick={() => void perform(window.manager.choose)}><FolderOpen size={18} /></button>
    </section>
    <section className="overview">
      <div className={`status-symbol ${state.busy ? 'working' : issue || stale ? 'unknown' : status?.state || ''}`}>
        <Power size={23} />
      </div>
      <div className="status-copy"><h2 aria-live="polite">{text}</h2>
        <p>{status ? `本机 v${status.version}` : 'Codex Remote'}{status && !state.busy ? ` · ${stale ? '状态已过期' : `${Math.max(0, Math.floor((now - status.checkedAt) / 1000))} 秒前检查`}` : ''}</p></div>
      <div className="actions">
        {status?.service.running ? <button disabled={disabled || !canControl} onClick={() => void perform(() => window.manager.action('Stop'))}><Square size={15} />关闭</button>
          : <button className="primary" disabled={disabled || !canControl} onClick={() => void perform(() => window.manager.action('Start'))}><Play size={15} />开启</button>}
        <button className="icon" title="重启 Remote" aria-label="重启 Remote" disabled={disabled || !canControl || !status?.service.running}
          onClick={() => void perform(() => window.manager.action('Restart'))}><RotateCw size={17} /></button>
      </div>
    </section>
    {issue && <div className="message error" role="alert"><span>{issue}</span><button className="icon" title="清除操作提示" aria-label="清除操作提示" onClick={() => setError('')}><X size={16} /></button></div>}
    {state.result && <div className="message" role="status">{state.result}</div>}
    <nav aria-label="管理视图">
      <button aria-current={tab === 'status' ? 'page' : undefined} onClick={() => setTab('status')}><Activity size={15} />健康状态</button>
      <button aria-current={tab === 'update' ? 'page' : undefined} onClick={() => setTab('update')}><ArrowUpToLine size={15} />版本更新{state.release?.available && <span className="new-dot" />}</button>
    </nav>
    <div className="content">
      {tab === 'status' ? <>
        <dl className="health">
          <Row name="本地服务" value={status ? status.backend.reachable ? `${status.backend.ms} ms` : '未响应' : '等待检测'} good={status?.backend.reachable} stale={stale} />
          <Row name="Desktop 同步" value={status ? status.desktop ? '已连接' : '未就绪' : '等待检测'} good={status?.desktop} stale={stale} />
          <Row name="访问密码" value={status ? status.passwordConfigured ? '已设置' : status.backend.reachable ? '未设置' : '等待服务' : '等待检测'} good={status?.passwordConfigured} stale={stale} />
          <Row name="Cloudflare 隧道" value={status?.tunnel.managed ? status.tunnel.ready ? '已连接' : '未就绪' : '独立管理 / 未配置'} good={status?.tunnel.managed ? status.tunnel.ready : undefined} stale={stale} />
          <Row name="Remote 登录启动" value={status ? status.service.enabled ? '已启用' : '未启用' : '等待检测'} stale={stale} />
        </dl>
        <div className="links">
          <button disabled={disabled || !status?.backend.reachable || stale} onClick={() => void perform(window.manager.open)}><ExternalLink size={16} />打开 Remote</button>
          <button disabled={disabled || !state.root} onClick={() => void perform(window.manager.folder)}><FolderOpen size={16} />安装文件</button>
        </div>
        <details><summary>操作记录 <span>{state.events.length}</span></summary>
          {state.events.length ? <ol className="events">{state.events.map((item, index) => <li key={`${item.time}-${index}`}><time>{new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{item.message}</span></li>)}</ol> : <p className="empty">暂无操作记录</p>}
        </details>
      </> : <section className="updates">
        <div className="update-heading"><div><h3>本机 Codex Remote</h3><p>{status ? `当前版本 ${status.version}` : '请选择安装目录'}</p></div>
          <button disabled={disabled || !status} onClick={() => void perform(window.manager.check)}><RefreshCw size={15} />检查更新</button></div>
        {state.release?.available && <><h3 className="release-title">新版本 {state.release.version}</h3><pre className="notes">{state.release.notes || '此版本没有更新摘要。'}</pre>
          <button className="primary" disabled={disabled || !canControl} onClick={() => void perform(window.manager.update)}><ArrowUpToLine size={16} />更新到 {state.release.version}</button></>}
      </section>}
    </div>
    <footer>
      <label title={state.packaged ? undefined : '安装版可启用此选项'}><input type="checkbox" checked={state.launchAtLogin} disabled={disabled || !state.packaged}
        onChange={(e) => void perform(() => window.manager.login(e.target.checked))} />登录时启动管理器</label>
      <button disabled={disabled} onClick={() => void perform(window.manager.quit)}>退出管理器</button>
    </footer>
  </main>;
}
function Row({ name, value, good, stale }: { name: string; value: string; good?: boolean; stale: boolean }) {
  return <div><dt>{name}</dt><dd className={!stale && good !== undefined ? good ? 'ok' : 'warn' : ''}><span className="dot" />{stale ? '等待检测' : value}</dd></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
