import { CheckCircle2, Eye, EyeOff, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { api } from './api';
import type { WorkspaceBootstrap } from './types';
import { PanelBoundary } from './components/PanelBoundary';
import { isReturningDevice, rememberDevice, startSession } from './startup';
import { clearDeviceSnapshots } from './device-snapshots';

const loadWorkspace = () => import('./Workspace').then((module) => ({ default: module.Workspace }));
const Workspace = lazy(loadWorkspace);

interface AuthState {
  configured: boolean;
  authenticated: boolean;
  setupAllowed: boolean;
  authFile?: string;
  workspace: WorkspaceBootstrap | null;
  bootstrapRequest?: Promise<WorkspaceBootstrap | null>;
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [returningDevice, setReturningDevice] = useState(isReturningDevice);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const establishedRef = useRef(false);
  const refreshAuth = useCallback(() => {
    establishedRef.current = false;
    setAuth(null);
    setRevision(value => value + 1);
  }, []);
  const expireAuth = useCallback(() => {
    void clearDeviceSnapshots();
    rememberDevice(false);
    setReturningDevice(false);
    refreshAuth();
  }, [refreshAuth]);
  const signedIn = useCallback(() => {
    rememberDevice(true);
    setReturningDevice(true);
    establishedRef.current = true;
    setAuth(null);
    setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let pending = false;
    let verified = false;
    if (isReturningDevice() || establishedRef.current) void loadWorkspace().catch(() => undefined);
    const check = async () => {
      if (pending || controller.signal.aborted) return;
      clearTimeout(timer);
      pending = true;
      try {
        const session = startSession(controller.signal, establishedRef.current);
        const state = await session.auth;
        if (controller.signal.aborted) return;
        verified = true;
        if (state.authenticated) void loadWorkspace().catch(() => undefined);
        if (!state.authenticated) void clearDeviceSnapshots();
        rememberDevice(state.authenticated);
        setReturningDevice(state.authenticated);
        const bootstrapRequest = state.authenticated ? session.workspace : undefined;
        setAuth({ ...state, workspace: null, ...(bootstrapRequest ? { bootstrapRequest } : {}) });
        setError(null);
      } catch {
        if (controller.signal.aborted) return;
        setError(navigator.onLine ? '连接暂不可用，正在重试' : '网络已断开，等待恢复');
        timer = setTimeout(() => { void check(); }, Math.min(1000 * 2 ** failures++, 8000));
      } finally { pending = false; }
    };
    const recover = () => {
      if (!verified && document.visibilityState === 'visible') {
        if (pending) refreshAuth();
        else void check();
      }
    };
    void check();
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [revision, refreshAuth]);

  if (!auth && !returningDevice) return <FullScreenLoader label={error ?? '正在检查登录状态'}
    {...(error ? { onRetry: refreshAuth } : {})} />;

  if (auth && !auth.configured) {
    return <SetupPage setupAllowed={auth.setupAllowed} onDone={signedIn} />;
  }

  if (auth && !auth.authenticated) {
    return <LoginPage onDone={signedIn} />;
  }

  return <PanelBoundary><Suspense fallback={<FullScreenLoader label="正在打开工作区" />}>
    <Workspace authenticated={auth?.authenticated ?? false} onAuthExpired={expireAuth}
      bootstrap={auth?.workspace ?? null} bootstrapRequest={auth?.bootstrapRequest}
      startupError={auth ? null : error} onStartupRetry={refreshAuth} />
  </Suspense></PanelBoundary>;
}

function SetupPage({ setupAllowed, onDone }: { setupAllowed: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  return (
    <AuthShell
      title="保护远程任务"
      description="设置一个访问密码。密码只保存为本机哈希，不会发送给浏览器。"
    >
      {!setupAllowed ? (
        <div className="auth-notice">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>需要在这台电脑上完成设置</strong>
            <p>远程连接不能创建初始密码。请打开本机地址，或运行 npm run set-password。</p>
          </div>
        </div>
      ) : (
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (password !== confirm) {
              setError('两次输入的密码不一致。');
              return;
            }
            setWorking(true);
            void api('/api/auth/setup', {
              method: 'POST',
              timeoutMs: 15000,
              body: JSON.stringify({ password })
            })
              .then(onDone)
              .catch((nextError) => setError(errorMessage(nextError)))
              .finally(() => setWorking(false));
          }}
        >
          <label className="field">
            <span>访问密码</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoFocus
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>
          <label className="field">
            <span>确认密码</span>
            <input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="primary-button primary-button--wide" disabled={working}>
            {working ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            完成设置
          </button>
        </form>
      )}
    </AuthShell>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  return (
    <AuthShell
      title="登录"
      description=""
    >
      <form
        className="auth-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!password) {
            setError('请先输入访问密码。');
            passwordRef.current?.focus();
            return;
          }
          if (working) return;
          setWorking(true);
          setError(null);
          void api('/api/auth/login', {
            method: 'POST',
            timeoutMs: 15000,
            body: JSON.stringify({ password })
          })
            .then(onDone)
            .catch((nextError) => setError(errorMessage(nextError)))
            .finally(() => setWorking(false));
        }}
      >
        <div className="field">
          <label htmlFor="login-password">访问密码</label>
          <span className="auth-password">
            <input
              id="login-password"
              ref={passwordRef}
              placeholder="访问密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoFocus
              autoComplete="current-password"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
            <button type="button" className="icon-button" title={showPassword ? '隐藏密码' : '显示密码'}
              aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword}
              onClick={() => setShowPassword(value => !value)}>
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
        </div>
        {error && <div className="form-error" id="login-error" role="alert">{error}</div>}
        <button type="submit" className="primary-button primary-button--wide" disabled={working}>
          {working ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
          登录
        </button>
      </form>
    </AuthShell>
  );
}

function AuthShell({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <img src="/codex-mark.svg" width={48} height={48} alt="Codex" />
        </div>
        <div className="auth-copy">
          <h1 id="auth-title">{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {children}
      </section>
    </main>
  );
}

function FullScreenLoader({ label, onRetry }: { label: string; onRetry?: () => void }) {
  return (
    <div className="fullscreen-loader" role="status">
      <LoaderCircle size={20} className="spin" aria-hidden="true" />
      <span>{label}</span>
      {onRetry && <button type="button" className="icon-button" title="重新连接" aria-label="重新连接" onClick={onRetry}>
        <RefreshCw size={18} />
      </button>}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
