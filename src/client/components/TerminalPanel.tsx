import { ArrowDown, ArrowDownToLine, ArrowUp, CornerDownLeft, Plus, SquareTerminal, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { RemoteConnection, type RemoteChannel } from '../remote-connection';
import { copyText } from '../clipboard';
import type { TerminalClientMessage, TerminalInfo, TerminalServerMessage } from '../../shared/terminal';
import './terminal.css';

export default function TerminalPanel({ cwd, onClose, startAtCwd = false, onDirectoryOpened }: {
  cwd: string | undefined; onClose: () => void; startAtCwd?: boolean; onDirectoryOpened?: (cwd: string | undefined) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controls = useRef<{ send: (message: TerminalClientMessage) => void; focus: () => void; bottom: () => void } | null>(null);
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [directory, setDirectory] = useState(cwd ?? '');
  const [cwdFallback, setCwdFallback] = useState(false);
  const [status, setStatus] = useState('连接中');
  const [inputReady, setInputReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = sessions.find((session) => session.id === activeId);

  useEffect(() => {
    const host = hostRef.current!;
    const terminal = new Terminal({
      cursorBlink: true, disableStdin: true, scrollback: 1000, fontSize: 12, lineHeight: 1.5,
      fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: { background: '#ffffff', foreground: '#0d0d0d', cursor: '#303030', selectionBackground: '#cdddf3',
        black: '#303030', red: '#b42318', green: '#21723a', yellow: '#8a6000', blue: '#2458ae',
        magenta: '#9635a0', cyan: '#007c85', white: '#ededed',
        brightBlack: '#666666', brightRed: '#c62f26', brightGreen: '#287f40', brightYellow: '#936600',
        brightBlue: '#3465bd', brightMagenta: '#a440ad', brightCyan: '#00838c', brightWhite: '#ffffff' }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    let socket: RemoteChannel | null = null;
    let attachedId: string | null = null;
    let ready = false;
    let disposed = false;
    let frame = 0;
    let rendering = Promise.resolve();
    let requireSelectedDirectory = startAtCwd;

    function send(message: TerminalClientMessage) {
      if (message.type === 'terminal.input' && !ready) return;
      if (message.type === 'terminal.create' || message.type === 'terminal.attach') {
        ready = false;
        terminal.options.disableStdin = true;
        setInputReady(false);
        setStatus('连接中');
      }
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
    function fitTerminal() {
      if (!ready || !host.clientWidth || !host.clientHeight) return;
      const size = fit.proposeDimensions();
      if (!size) return;
      const cols = Math.min(500, Math.max(2, size.cols));
      const rows = Math.min(300, Math.max(1, size.rows));
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
        if (attachedId) send({ type: 'terminal.resize', sessionId: attachedId, cols, rows });
      }
    }
    function scheduleFit() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void rendering.then(() => { if (!disposed) fitTerminal(); }); });
    }
    function render(action: () => Promise<void> | void) {
      rendering = rendering.then(() => { if (!disposed) return action(); });
    }
    function write(data: string): Promise<void> {
      return new Promise((resolve) => terminal.write(data, resolve));
    }
    function onMessage(message: TerminalServerMessage) {
      if (message.type === 'terminal.state') {
        if (requireSelectedDirectory) {
          requireSelectedDirectory = false;
          onDirectoryOpened?.(cwd);
        }
        setSessions(message.sessions);
        setActiveId(message.activeSessionId);
        setDirectory(message.cwd);
        setCwdFallback(message.cwdFallback);
        if (message.activeSessionId !== attachedId) {
          ready = false;
          terminal.options.disableStdin = true;
          setInputReady(false);
        }
        if (!message.activeSessionId) {
          attachedId = null; ready = false;
          render(() => terminal.reset());
        }
      } else if (message.type === 'terminal.snapshot') {
        attachedId = message.sessionId;
        ready = false;
        setError(null);
        render(async () => {
          terminal.reset();
          terminal.resize(message.cols, message.rows);
          await write(message.data);
          if (disposed || attachedId !== message.sessionId || socket?.readyState !== WebSocket.OPEN) return;
          ready = true;
          terminal.options.disableStdin = false;
          setInputReady(true);
          setStatus('已连接');
          fitTerminal();
          // Keep the mobile keyboard closed until the user taps the terminal.
          if (matchMedia('(pointer: fine)').matches) terminal.focus();
        });
      } else if (message.type === 'terminal.output' && message.sessionId === attachedId) {
        render(async () => {
          await write(message.data);
          if (!disposed) send({ type: 'terminal.ack', sessionId: message.sessionId, size: message.data.length });
        });
      } else if (message.type === 'terminal.resized' && message.sessionId === attachedId) {
        render(() => terminal.resize(message.cols, message.rows));
      } else if (message.type === 'terminal.error') {
        setError(message.message);
      }
    }

    const input = terminal.onData((data) => {
      if (ready && attachedId) send({ type: 'terminal.input', sessionId: attachedId, data });
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') return false;
      if (event.ctrlKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        if (event.type === 'keydown') void copyText(terminal.getSelection()).catch(error =>
          setError(error instanceof Error ? error.message : String(error)));
        return false;
      }
      return true;
    });
    const connection = new RemoteConnection<TerminalServerMessage>({
      url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/terminal`,
      onSocket: (next) => { socket = next; },
      onOpen: () => {
        setError(null); setStatus('连接中');
        send({ type: 'terminal.open', ...(cwd ? { cwd } : {}), ...(requireSelectedDirectory ? { startAtCwd: true } : {}) });
      },
      onMessage,
      onDisconnect: () => {
        ready = false; terminal.options.disableStdin = true;
        setInputReady(false); setStatus('重新连接中');
      }
    });
    controls.current = { send, focus: () => terminal.focus(), bottom: () => terminal.scrollToBottom() };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    setSessions([]); setActiveId(null); setDirectory(cwd ?? ''); setCwdFallback(false);
    setError(null); setInputReady(false); setStatus('连接中');
    connection.start();
    return () => {
      disposed = true;
      controls.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      connection.dispose();
      terminal.dispose();
    };
  }, [cwd]);

  function input(data: string) {
    if (activeId) controls.current?.send({ type: 'terminal.input', sessionId: activeId, data });
    controls.current?.focus();
  }

  return (
    <section className="terminal-panel" aria-label="工作区终端">
      <header className="terminal-toolbar">
        <span className="terminal-heading"><SquareTerminal size={15} /><span>终端</span></span>
        <span className="terminal-directory" title={`当前目录：${active?.cwdStatus === 'reported' ? active.cwd : '尚未确认'}；起始目录：${directory}；同起始目录的任务共享终端。`}
          aria-label={`终端${active?.cwdStatus === 'reported' ? '当前' : '起始'}目录：${active?.cwdStatus === 'reported' ? active.cwd : directory}`}>
          <span>{active?.cwdStatus === 'reported' ? '当前目录' : '起始目录'}</span> {active?.cwdStatus === 'reported' ? active.cwd : directory || '等待连接'}
        </span>
        <span className="terminal-status" data-ready={inputReady} role="status">{active && active.exitCode !== null ? `已退出 ${active.exitCode}` : status}</span>
        <button type="button" className="icon-button" title="新建终端" aria-label="新建终端"
          disabled={!inputReady}
          onClick={() => controls.current?.send({ type: 'terminal.create' })}><Plus size={16} /></button>
        <button type="button" className="icon-button" title="滚动到底部" aria-label="滚动到底部"
          onClick={() => controls.current?.bottom()}><ArrowDownToLine size={15} /></button>
        <button type="button" className="icon-button" title="隐藏终端" aria-label="隐藏终端" onClick={onClose}><X size={16} /></button>
      </header>
      {cwdFallback && <div className="terminal-directory-notice" role="status">未能确定任务或项目目录，已回退到主机默认目录：{directory}</div>}
      {active && active.exitCode === null && active.cwdStatus !== 'reported' && <div className="terminal-directory-notice" role="status">
        {active.cwdStatus === 'pending' ? '等待 shell 上报当前目录。' : '无法读取 shell 当前目录；上方仅显示起始目录，请在 shell 中确认所在位置。'}
      </div>}
      {sessions.length > 0 && <div className="terminal-tabs" role="tablist" aria-label="终端会话">
        {sessions.map((session) => <div className={`terminal-tab${session.id === activeId ? ' is-active' : ''}`} key={session.id}>
          <button type="button" role="tab" aria-selected={session.id === activeId} aria-controls="workspace-terminal-screen"
            title={session.shell} onClick={() => controls.current?.send({ type: 'terminal.attach', sessionId: session.id })}>
            {session.title}{session.exitCode !== null ? ' · 已退出' : ''}
          </button>
          <button type="button" title="结束终端" aria-label={`结束终端 ${session.title}`}
            onClick={() => controls.current?.send({ type: 'terminal.close', sessionId: session.id })}><Trash2 size={13} /></button>
        </div>)}
      </div>}
      {error && <div className="terminal-error" role="alert">{error}</div>}
      <div className="terminal-screen" id="workspace-terminal-screen" role="tabpanel" ref={hostRef} />
      <div className="terminal-touch-keys" inert={!inputReady || active?.exitCode !== null}>
        <button type="button" onClick={() => input('\x03')}>Ctrl+C</button>
        <button type="button" onClick={() => input('\t')}>Tab</button>
        <button type="button" onClick={() => input('\x1b')}>Esc</button>
        <button type="button" aria-label="上一条命令" onClick={() => input('\x1b[A')}><ArrowUp size={16} /></button>
        <button type="button" aria-label="下一条命令" onClick={() => input('\x1b[B')}><ArrowDown size={16} /></button>
        <button type="button" aria-label="回车" onClick={() => input('\r')}><CornerDownLeft size={16} /></button>
      </div>
    </section>
  );
}
