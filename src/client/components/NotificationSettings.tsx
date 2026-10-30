import { Bell, BellOff, Check, LoaderCircle, Send, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  disableDeviceNotifications, enableDeviceNotifications, getNotificationCapability,
  readDeviceNotificationState, sendDeviceTestNotification, type DeviceNotificationState
} from '../push-notifications';
import './notification-settings.css';

export function NotificationSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [capability] = useState(getNotificationCapability);
  const [state, setState] = useState<DeviceNotificationState | null>(null);
  const [checking, setChecking] = useState(capability.supported);
  const [busy, setBusy] = useState<'enable' | 'test' | 'disable' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!capability.supported || busyRef.current) return;
    const version = ++requestVersion.current;
    setChecking(true);
    try {
      const result = await readDeviceNotificationState();
      if (mounted.current && version === requestVersion.current) {
        setState(result);
        setError(null);
      }
    } catch (error) {
      if (mounted.current && version === requestVersion.current) {
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (mounted.current && version === requestVersion.current) setChecking(false);
    }
  }, [capability.supported]);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void refresh();
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      mounted.current = false;
      requestVersion.current++;
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [refresh]);

  function act(kind: 'enable' | 'test' | 'disable') {
    if (busyRef.current) return;
    busyRef.current = true;
    requestVersion.current++;
    setBusy(kind);
    setChecking(false);
    setError(null);
    setNotice(null);
    // Keep enable synchronous up to requestPermission; do not put a read before it.
    const task = kind === 'enable' ? enableDeviceNotifications()
      : kind === 'disable' ? disableDeviceNotifications()
      : sendDeviceTestNotification();
    void task.then(result => {
      if (!mounted.current) return;
      if (result) setState(result);
      setNotice(kind === 'test' ? '测试通知已发送，请查看系统通知。'
        : kind === 'disable' ? '此设备通知已关闭。' : '此设备的网站通知已开启。');
    }).catch(async error => {
      if (!mounted.current) return;
      setError(error instanceof Error ? error.message : String(error));
      try {
        const result = await readDeviceNotificationState();
        if (mounted.current) setState(result);
      } catch { /* Keep the last confirmed state when checking also fails. */ }
    }).finally(() => {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    });
  }

  const enabled = Boolean(state?.enabled);
  const denied = state?.permission === 'denied';
  return <dialog ref={dialog} className="notification-settings" aria-labelledby="notification-settings-title"
    onClose={onClose}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <header>
      <h2 id="notification-settings-title"><Bell size={18} />消息通知</h2>
      <button type="button" className="icon-button" aria-label="关闭通知设置" title="关闭" disabled={Boolean(busy)}
        onClick={onClose}><X size={18} /></button>
    </header>
    <div className="notification-settings-body">
      <p className="notification-intro">任务完成、需要回答或审批时接收系统通知，包含会话标题及回复或问题摘要。</p>
      {capability.reason === 'home-screen' ? <div className="notification-guidance">
        <Smartphone size={20} aria-hidden="true" />
        <div><strong>从主屏幕开启通知</strong><p>iPhone 和 iPad 需要 iOS / iPadOS 16.4 或更新版本。在 Safari 中打开本网站，选择“分享”→“添加到主屏幕”，再从主屏幕图标打开并开启通知。</p></div>
      </div> : capability.reason === 'https' ? <p className="notification-guidance">
        请通过 HTTPS 地址打开网站后开启通知。本机 localhost 地址也可使用。
      </p> : capability.reason === 'unsupported' ? <p className="notification-guidance">
        当前浏览器不支持网站推送，请使用支持通知的浏览器。
      </p> : null}
      {denied && <p className="notification-guidance">通知权限已关闭。请在浏览器的网站设置或系统通知设置中允许通知，然后回到此处。</p>}
      <button type="button" className={`notification-enable${enabled ? ' is-enabled' : ''}`}
        disabled={!capability.supported || Boolean(busy) || checking || enabled || denied}
        onClick={() => act('enable')}>
        {checking || busy === 'enable' ? <LoaderCircle size={17} className="spin" /> : enabled ? <Check size={17} /> : <Bell size={17} />}
        <span>{checking ? '正在检查通知状态' : busy === 'enable' ? '正在开启通知'
          : enabled ? '网站通知已开启' : '开启网站通知'}</span>
      </button>
      <div className="notification-actions">
        <button type="button" disabled={!enabled || Boolean(busy) || checking} onClick={() => act('test')}>
          {busy === 'test' ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
          <span>发送测试通知</span>
        </button>
        <button type="button" disabled={!state?.subscribed || Boolean(busy) || checking} onClick={() => act('disable')}>
          {busy === 'disable' ? <LoaderCircle size={16} className="spin" /> : <BellOff size={16} />}
          <span>关闭此设备通知</span>
        </button>
      </div>
      <div className="notification-feedback" aria-live="polite">
        {error ? <p className="notification-error" role="alert">{error}</p> : notice ? <p>{notice}</p> : null}
      </div>
    </div>
  </dialog>;
}
