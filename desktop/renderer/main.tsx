import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import { ArrowUpToLine, ChevronDown, ExternalLink, FolderOpen, KeyRound, LogOut, RefreshCw, RotateCw, ScanSearch, ShieldCheck, Wrench, X } from 'lucide-react';
import './style.css';

import type { State, Result, AuthRequest } from './contract';
import { ManagerUpdate } from './ManagerUpdate';

const initial: State = { root: '', version: '', platform: '', packaged: false, launchAtLogin: false,
  status: null, busy: '', error: '', healthError: '', result: '', release: null, events: [], installations: [],
  updateProgress: null, recoveryRequired: false, security: null, connectionReport: null, logs: null, managerUpdate: null };
const labels = { healthy: '运行正常', degraded: '需要检查', stopped: '已关闭',
  conflict: '安装目录冲突', unowned: '端口被占用' };
function App() {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState('status');
  const [now, setNow] = useState(Date.now());
  const [diagnosing, setDiagnosing] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deviceLimit, setDeviceLimit] = useState(20);
  useEffect(() => {
    const unsubscribe = window.manager.subscribe(setState);
    void window.manager.get().then(result => { if (result.value) setState(result.value); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);
  useEffect(() => { setPassword(''); setConfirm(''); setPasswordOpen(false); setDiagnosing(false); }, [state.root]);
  useEffect(() => {
    if (tab !== 'security') { setPassword(''); setConfirm(''); setPasswordOpen(false); }
  }, [tab]);
  async function perform(fn: () => Promise<Result>) {
    if (pending || state.busy) return;
    setPending(true); setError('');
    try {
      const result = await fn();
      if (result.value) setState(result.value);
      if (!result.ok) setError(result.error || '操作失败');
    } catch { setError('无法连接本机管理器。'); }
    finally { setPending(false); }
  }
  function devices(editPassword = false) {
    setTab('security'); setPasswordOpen(editPassword);
    void perform(() => window.manager.security({ action: 'list' }));
  }
  function diagnose() { setDiagnosing(true); void perform(window.manager.diagnose); }
  const status = state.status;
  const disabled = pending || Boolean(state.busy) || state.managerUpdate?.status === 'installing';
  const conflict = status && ['conflict', 'unowned'].includes(status.state);
  const stale = !status || now - status.checkedAt > 20_000;
  const canControl = Boolean(status) && !conflict && !state.healthError && !stale && !state.recoveryRequired;
  const canRepair = canControl && status?.service.running && status.service.enabled;
  const text = state.busy ? state.updateProgress ? state.updateProgress.status === 'recovering' ? '正在恢复' : '正在更新' : state.busy
    : state.healthError ? '检测未完成' : status ? labels[status.state] : state.root ? '正在检测' : '选择安装目录';
  const issue = error || state.error || state.healthError;
  const publicValue = !status?.publicEntry.configured ? '未设置' : status.publicEntry.reachable ? '可达'
    : status.publicEntry.state === 'unknown' ? '待确认' : '响应异常';
  const report = state.connectionReport || status?.publicEntry;
  return <main>
    <header>
      <img src="./app.png" width="28" height="28" alt="" />
      <div className="brand"><h1>Codex Remote</h1><span>本机管理器 <span className="version">v{state.version}</span></span></div>
      <IconButton title="刷新状态" disabled={disabled} onClick={() => void perform(window.manager.refresh)}><RefreshCw size={16} /></IconButton>
    </header>
    <section className="overview">
      <div className="status-line">
        <div className="status-copy">
          <h2 aria-live="polite"><span className={`status-dot ${state.busy ? 'working' : stale || state.healthError ? '' : status?.state}`} />{text}</h2>
          <p>{status ? `Remote v${status.version}` : 'Remote'}
            {status && !state.busy ? ` · ${stale ? '状态已过期' : now - status.checkedAt < 5000 ? '刚刚检查' : `${Math.max(0, Math.floor((now - status.checkedAt) / 1000))} 秒前检查`}` : ''}</p>
        </div>
        <div className="actions">
          <button className="service-toggle" role="switch" aria-checked={Boolean(status?.service.running)}
            aria-label={status?.service.running ? '关闭 Remote' : '开启 Remote'}
            title={status?.service.running ? '关闭 Remote' : '开启 Remote'} disabled={disabled || !canControl}
            onClick={() => void perform(() => window.manager.action(status?.service.running ? 'Stop' : 'Start'))}>
            <span className="toggle-track"><span /></span>
          </button>
        </div>
      </div>
      <div className="launch">
        <button className="primary" disabled={disabled || !status?.backend.reachable || stale}
          onClick={() => void perform(window.manager.open)}><ExternalLink size={16} />打开 Remote</button>
        <IconButton title="重启 Remote" disabled={disabled || !canControl || !status?.service.running}
          onClick={() => void perform(() => window.manager.action('Restart'))}><RotateCw size={16} /></IconButton>
      </div>
    </section>
    <nav aria-label="管理视图">
      <button aria-current={tab === 'status' ? 'page' : undefined} onClick={() => setTab('status')}>概览</button>
      <button aria-current={tab === 'security' ? 'page' : undefined} onClick={() => devices()}>设备与密码</button>
      <button aria-current={tab === 'update' ? 'page' : undefined} onClick={() => setTab('update')}>版本更新{(state.release?.available ||
        ['available', 'downloaded'].includes(state.managerUpdate?.status || '')) && <span className="new-dot" />}</button>
    </nav>
    <div className="content">
      {state.recoveryRequired && <div className="message" role="alert"><span>存在未完成更新，请先恢复旧版。</span>
        <button disabled={disabled} onClick={() => void perform(window.manager.recover)}><RotateCw size={14} />重试恢复</button>
      </div>}
      {issue && <div className="message error" role="alert"><span>{issue}</span>
        {(error || state.error) && <IconButton title="清除操作提示" disabled={disabled}
          onClick={() => { setError(''); void perform(window.manager.dismiss); }}><X size={15} /></IconButton>}
      </div>}
      {state.result && <div className="message" role="status"><span>{state.result}</span></div>}
      {state.updateProgress && <UpdateProgress progress={state.updateProgress} now={now} />}
      {tab === 'status' ? <>
        {!stale && status?.diagnostics?.map(message => <div className="message" role="status" key={message}>{message}</div>)}
        <dl className="health">
          <Row name="本地服务" value={status ? status.backend.reachable ? `${status.backend.ms} ms` : '未响应' : '等待检测'} good={status?.backend.reachable} stale={stale}
            action={status && !status.backend.ready && <IconButton title={status.service.running ? '修复本地服务' : '开启 Remote'} disabled={disabled || !canControl}
              onClick={() => void perform(() => status.service.running ? window.manager.repair('Server') : window.manager.action('Start'))}><Wrench size={14} /></IconButton>} />
          <Row name="Desktop 同步" value={status ? status.desktop ? '已连接' : '未就绪' : '等待检测'} good={status?.desktop} stale={stale}
            action={status && !status.desktop && <IconButton title="重连 Desktop 同步" disabled={disabled || !canRepair}
              onClick={() => void perform(() => window.manager.repair('Server'))}><RotateCw size={14} /></IconButton>} />
          <Row name="访问密码" value={status ? status.passwordConfigured ? '已设置' : '未设置' : '等待检测'} good={status?.passwordConfigured} stale={stale}
            action={<IconButton title="修改访问密码" disabled={disabled || !state.root || state.recoveryRequired} onClick={() => devices(true)}><KeyRound size={14} /></IconButton>} />
          <Row name="Cloudflare 隧道" value={status?.tunnel.managed ? status.tunnel.ready ? '已连接' : '未就绪'
            : status?.publicEntry.configured ? '外部管理' : '未配置'} good={status?.tunnel.managed ? status.tunnel.ready : undefined} stale={stale}
            action={status?.tunnel.managed && !status.tunnel.ready && <IconButton title="修复受管隧道" disabled={disabled || !canRepair}
              onClick={() => void perform(() => window.manager.repair('Tunnel'))}><Wrench size={14} /></IconButton>} />
          <Row name="公网入口" value={publicValue} good={status?.publicEntry.reachable ? true : status?.publicEntry.state === 'unknown' || !status?.publicEntry.configured ? undefined : false} stale={stale}
            action={<IconButton title="诊断公网连接" disabled={disabled || !status?.publicEntry.configured} onClick={diagnose}><ScanSearch size={14} /></IconButton>} />
          <Row name="Remote 登录启动" value={status ? status.service.enabled ? '已启用' : '未启用' : '等待检测'} stale={stale} />
        </dl>
        {diagnosing && <section className="connection-report" aria-label="连接诊断">
          <div className="section-heading"><h3>连接诊断</h3><IconButton title="收起连接诊断" onClick={() => setDiagnosing(false)}><X size={14} /></IconButton></div>
          <p className="detail" role="status">{report?.detail || '正在检查连接。'}</p>
          {state.connectionReport && <p className="meta">复检于 {new Date(state.connectionReport.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}</p>}
          <div className="inline-actions">
            <button disabled={disabled} onClick={diagnose}><RefreshCw size={14} />重新检测</button>
            <button disabled={disabled || !status?.publicEntry.configured} onClick={() => void perform(window.manager.open)}><ExternalLink size={14} />打开入口</button>
            {status?.tunnel.managed && !status.tunnel.ready && <button disabled={disabled || !canRepair}
              onClick={() => void perform(() => window.manager.repair('Tunnel'))}><Wrench size={14} />修复隧道</button>}
          </div>
        </section>}
        <details className="installation" open={!state.root || undefined}>
          <summary><span>安装目录</span><span className="path" title={state.root}>{state.root.split(/[\\/]/).filter(Boolean).pop() || '尚未选择'}</span><ChevronDown size={14} /></summary>
          <p className="full-path">{state.root || '尚未选择'}</p>
          <div className="inline-actions">
            <button disabled={disabled} onClick={() => void perform(window.manager.detect)}><ScanSearch size={14} />自动探测</button>
            <button disabled={disabled} onClick={() => void perform(window.manager.choose)}><FolderOpen size={14} />选择目录</button>
            <IconButton title="打开安装文件" disabled={disabled || !state.root} onClick={() => void perform(window.manager.folder)}><ExternalLink size={14} /></IconButton>
          </div>
        </details>
        {state.installations.length > 1 && <div className="installation-choices"><select aria-label="选择探测到的安装目录" disabled={disabled} value={state.root}
          onChange={event => void perform(() => window.manager.select(event.target.value))}>
          <option value="" disabled>请选择安装目录</option>
          {state.installations.map(item => <option key={item.root} value={item.root}>{item.root} · v{item.version}{item.source === 'service' ? ' · 系统服务' : ''}</option>)}
        </select></div>}
        <details className="log-view"><summary><span>运行日志</span><ChevronDown size={14} /></summary>
          <div className="inline-actions">
            <button disabled={disabled || !state.root} onClick={() => void perform(() => window.manager.logs('Server'))}>服务日志</button>
            <button disabled={disabled || !state.root} onClick={() => void perform(() => window.manager.logs('Tunnel'))}>隧道日志</button>
          </div>
          {state.logs && <pre className="raw-output" aria-label="运行日志内容">{state.logs.text}</pre>}
        </details>
        <details><summary><span>操作记录 <span className="count">{state.events.length}</span></span><ChevronDown size={14} /></summary>
          {state.events.length ? <ol className="events">{state.events.map((item, index) => <li key={`${item.time}-${index}`}><time>{new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{item.message}</span></li>)}</ol> : <p className="empty">暂无操作记录</p>}
        </details>
      </> : tab === 'security' ? <section className="security">
        <div className="section-heading"><h3>已认证设备 <span className="count">{state.security?.deviceCount ?? state.security?.devices.length ?? ''}</span></h3>
          <IconButton title="刷新设备列表" disabled={disabled || !state.root || state.recoveryRequired}
            onClick={() => void perform(() => window.manager.security({ action: 'list' }))}><RefreshCw size={15} /></IconButton></div>
        {state.security?.supported === false ? <p className="detail">请先更新本机 Remote，再管理密码和设备。</p> : <>
          {state.security?.legacyDevicesPossible && <p className="detail">旧版设备将在下次连接后登记；退出全部也会撤销尚未登记的旧登录。</p>}
          {!state.security ? <p className="empty">正在读取设备。</p> : !state.security.devices.length ? <div className="device-empty"><ShieldCheck size={23} /><p>暂无已认证设备</p></div>
            : <ul className="devices">{state.security.devices.slice(0, deviceLimit).map(device => <li key={device.id}>
              <div><h4>{device.name}</h4><p>最近活动 {new Date(device.lastSeenAt).toLocaleString('zh-CN', { hour12: false })}</p>
                <p>有效期至 {new Date(device.expiresAt).toLocaleDateString('zh-CN')}</p></div>
              <IconButton title={`撤销 ${device.name} 的认证`} disabled={disabled || state.recoveryRequired}
                onClick={() => void perform(() => window.manager.security({ action: 'revoke', id: device.id }))}><LogOut size={16} /></IconButton>
            </li>)}</ul>}
          {state.security && state.security.devices.length > deviceLimit && <button className="text-button" onClick={() => setDeviceLimit(value => value + 20)}>显示更多设备</button>}
          {state.security?.deviceCount && state.security.deviceCount > state.security.devices.length
            ? <p className="meta">仅列出最近 {state.security.devices.length} 条认证。</p> : null}
          <div className="inline-actions security-actions">
            <button disabled={disabled || !state.security?.supported || state.recoveryRequired}
              onClick={() => setPasswordOpen(value => !value)}><KeyRound size={14} />修改密码</button>
            <button disabled={disabled || !state.security?.passwordConfigured || state.recoveryRequired}
              onClick={() => void perform(() => window.manager.security({ action: 'revoke-all' }))}><LogOut size={14} />退出全部</button>
          </div>
          {passwordOpen && <form className="password-form" onSubmit={event => {
            event.preventDefault();
            if (password !== confirm) { setError('两次输入的密码不一致。'); return; }
            const request: AuthRequest = { action: 'password', password, confirm };
            setPassword(''); setConfirm('');
            void perform(() => window.manager.security(request));
          }}>
            <label>新密码<input type="password" autoComplete="new-password" minLength={6} maxLength={256} required disabled={disabled}
              value={password} onChange={event => setPassword(event.target.value)} /></label>
            <label>确认新密码<input type="password" autoComplete="new-password" minLength={6} maxLength={256} required disabled={disabled}
              value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
            <p className="detail">修改密码将退出所有已认证设备。</p>
            <div className="inline-actions"><button className="primary" disabled={disabled || password.length < 6 || confirm.length < 6}>保存密码</button>
              <button type="button" disabled={disabled} onClick={() => { setPassword(''); setConfirm(''); setPasswordOpen(false); }}>取消</button></div>
          </form>}
        </>}
      </section> : <section className="updates">
        <div className="update-heading"><div><h3>Remote</h3><p>{status ? `当前版本 ${status.version}` : '请选择安装目录'}</p></div>
          <button disabled={disabled || !status || state.recoveryRequired} onClick={() => void perform(window.manager.check)}><RefreshCw size={14} />检查更新</button></div>
        {state.release?.available && <><h3 className="release-title">新版本 {state.release.version}</h3><div className="notes">
          <ReactMarkdown components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{state.release.notes || '此版本没有更新摘要。'}</ReactMarkdown></div>
          <button className="primary" disabled={disabled || !canControl} onClick={() => void perform(window.manager.update)}><ArrowUpToLine size={15} />更新到 {state.release.version}</button></>}
        <ManagerUpdate state={state} disabled={disabled} perform={perform} />
      </section>}
    </div>
    <footer>
      <label title={state.packaged ? undefined : '安装版可启用此选项'}><input type="checkbox" checked={state.launchAtLogin} disabled={disabled || !state.packaged}
        onChange={event => void perform(() => window.manager.login(event.target.checked))} />登录时启动管理器</label>
      <button className="text-button" title="退出管理器" aria-label="退出管理器" disabled={disabled} onClick={() => void perform(window.manager.quit)}><LogOut size={13} />退出</button>
    </footer>
  </main>;
}
function IconButton({ title, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return <button type="button" className="icon" title={title} aria-label={title} {...props}>{children}</button>;
}
function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function UpdateProgress({ progress, now }: { progress: NonNullable<State['updateProgress']>; now: number }) {
  const running = progress.status === 'running' || progress.status === 'recovering';
  const quiet = now - (progress.lastOutputAt || progress.stepStartedAt);
  return <section className={`update-progress ${progress.status}`} aria-label="更新进度">
    <div className="progress-heading"><h3>{progress.title}</h3><span className="percentage">{progress.percent}%</span></div>
    <progress aria-label={progress.status === 'recovering' || progress.status === 'recovered' ? '旧版恢复进度' : '更新进度'} max="100" value={progress.percent} />
    <p className="detail" role="status">{progress.detail}</p>
    <p className="meta">总耗时 {duration((running ? now : progress.endedAt || now) - progress.startedAt)}
      {running && <> · 本步骤 {duration(now - progress.stepStartedAt)}</>}</p>
    {running && quiet >= 30_000 && <p className="progress-wait">{duration(quiet)}未收到新输出，仍在等待当前命令完成；超过最长等待时间会停止并报告结果。</p>}
    {progress.logs.length > 0 && <details className="update-output"><summary><span>最近输出 <span className="count">{progress.logs.length}</span></span><ChevronDown size={14} /></summary>
      <pre className="raw-output">{progress.logs.map(line => `${new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })} ${line.message}`).join('\n')}</pre>
    </details>}
  </section>;
}
function Row({ name, value, good, stale, action }: { name: string; value: string; good?: boolean; stale: boolean; action?: React.ReactNode }) {
  return <div><dt>{name}</dt><dd><span className={!stale && good !== undefined ? good ? 'ok' : 'warn' : ''}><span className="dot" />{stale ? '等待检测' : value}</span>{action}</dd></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
