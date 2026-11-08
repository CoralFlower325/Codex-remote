import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import headless from '@xterm/headless';
import serializer from '@xterm/addon-serialize';
import type { IDisposable } from 'node-pty';

import type { TerminalInfo, TerminalServerMessage } from '../shared/terminal.js';
import { terminalCwdIntegration, terminalReportedCwd } from './terminal-cwd.js';
import { spawnTerminal, type TerminalPty } from './terminal-process.js';

interface Session {
  info: TerminalInfo;
  pty: TerminalPty;
  screen: InstanceType<typeof headless.Terminal>;
  serialize: InstanceType<typeof serializer.SerializeAddon>;
  listeners: Set<(message: TerminalServerMessage) => void>;
  disposables: IDisposable[];
  pendingBytes: number;
  paused: boolean;
  closed: boolean;
  sizeOwner: ((message: TerminalServerMessage) => void) | null;
  cwdTimer: ReturnType<typeof setTimeout>;
  disposeIntegration: () => void;
}

export interface TerminalWorkspace {
  cwd: string;
  sessions: Map<string, Session>;
  activeSessionId: string | null;
  listeners: Set<() => void>;
}

export function terminalShell(platform = process.platform, env = process.env): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
  // Scheduled tasks may have a smaller PATH than an interactive desktop.
  const pwsh = path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(pwsh)
    ? { file: pwsh, args: ['-NoLogo'] }
    : { file: 'powershell.exe', args: ['-NoLogo'] };
}

export class TerminalManager {
  private readonly workspaces = new Map<string, TerminalWorkspace>();
  private nextTitle = 1;

  constructor(private readonly defaultCwd = os.homedir(),
    private readonly limits = { sessions: 32, perWorkspace: 8, workspaces: 64 }) {}

  open(cwd = this.defaultCwd): TerminalWorkspace {
    const resolved = fs.realpathSync.native(path.resolve(cwd));
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Terminal working directory is not a directory.');
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      for (const [id, value] of this.workspaces) {
        if (!value.sessions.size && !value.listeners.size) this.workspaces.delete(id);
      }
      if (this.workspaces.size >= this.limits.workspaces) throw new Error('终端工作区数量已达上限，请关闭不用的终端。');
      workspace = { cwd: resolved, sessions: new Map(), activeSessionId: null, listeners: new Set() };
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  list(workspace: TerminalWorkspace): TerminalInfo[] {
    return [...workspace.sessions.values()].map((session) => ({ ...session.info }));
  }

  create(workspace: TerminalWorkspace): string {
    const count = [...this.workspaces.values()].reduce((total, entry) => total + entry.sessions.size, 0);
    if (count >= this.limits.sessions || workspace.sessions.size >= this.limits.perWorkspace) {
      throw new Error('终端会话数量已达上限，请先结束不用的终端；现有 shell 会保持运行。');
    }
    const shell = terminalShell();
    const integration = terminalCwdIntegration(shell.file, shell.args);
    const screen = new headless.Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    const serialize = new serializer.SerializeAddon();
    screen.loadAddon(serialize);
    let pty: TerminalPty;
    try {
      pty = spawnTerminal(shell.file, integration.args, {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: workspace.cwd,
        useConptyDll: process.platform === 'win32',
        env: { ...process.env, ...integration.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
    } catch (error) {
      screen.dispose();
      integration.dispose();
      throw error;
    }
    const id = randomUUID();
    const title = `${path.basename(shell.file).replace(/\.exe$/i, '')} ${this.nextTitle++}`;
    const session: Session = {
      info: { id, title, cwd: workspace.cwd, initialCwd: workspace.cwd,
        cwdStatus: integration.supported ? 'pending' : 'unavailable', shell: shell.file, exitCode: null },
      pty, screen, serialize, listeners: new Set(), disposables: [],
      pendingBytes: 0, paused: false, closed: false, sizeOwner: null,
      disposeIntegration: integration.dispose,
      cwdTimer: setTimeout(() => {
        if (session.closed || session.info.cwdStatus !== 'pending') return;
        session.info.cwdStatus = 'unavailable';
        this.changed(workspace);
      }, 10_000)
    };
    session.cwdTimer.unref();
    session.disposables.push(screen.parser.registerOscHandler(7, (value) => {
      const cwd = terminalReportedCwd(value);
      const status = cwd ? 'reported' : 'unavailable';
      if (session.info.cwdStatus !== status || cwd && session.info.cwd !== cwd) {
        session.info.cwdStatus = status;
        if (cwd) session.info.cwd = cwd;
        this.changed(workspace);
      }
      clearTimeout(session.cwdTimer);
      return true;
    }));
    workspace.sessions.set(id, session);
    workspace.activeSessionId = id;
    session.disposables.push(pty.onData((data) => {
      if (session.closed) return;
      session.pendingBytes += data.length;
      if (!session.paused && session.pendingBytes > 128 * 1024) {
        session.paused = true;
        pty.pause();
      }
      // Snapshot state and live output advance together, including across reconnects.
      screen.write(data, () => {
        if (session.closed) return;
        this.emit(session, { type: 'terminal.output', sessionId: id, data });
        session.pendingBytes -= data.length;
        if (session.paused && session.pendingBytes < 32 * 1024) {
          session.paused = false;
          if (session.info.exitCode === null) pty.resume();
        }
      });
    }));
    session.disposables.push(pty.onExit(({ exitCode }) => {
      if (session.closed) return;
      session.info.exitCode = exitCode;
      clearTimeout(session.cwdTimer);
      session.disposeIntegration();
      this.changed(workspace);
    }));
    this.changed(workspace);
    return id;
  }

  attach(workspace: TerminalWorkspace, id: string, listener: (message: TerminalServerMessage) => void): () => void {
    const session = this.session(workspace, id);
    workspace.activeSessionId = id;
    session.listeners.add(listener);
    session.sizeOwner ??= listener;
    listener({
      type: 'terminal.snapshot', sessionId: id, data: session.serialize.serialize(),
      cols: session.screen.cols, rows: session.screen.rows
    });
    return () => {
      session.listeners.delete(listener);
      if (session.sizeOwner === listener) session.sizeOwner = session.listeners.values().next().value ?? null;
    };
  }

  input(workspace: TerminalWorkspace, id: string, data: string): void {
    const session = this.session(workspace, id);
    if (session.info.exitCode !== null) throw new Error('Terminal has exited.');
    session.pty.write(data);
  }

  resize(workspace: TerminalWorkspace, id: string, cols: number, rows: number,
    viewer?: (message: TerminalServerMessage) => void): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) {
      throw new Error('Invalid terminal dimensions.');
    }
    const session = this.session(workspace, id);
    if (viewer && session.sizeOwner !== viewer) {
      // A shared shell has one PTY geometry. Observers render its authoritative
      // size rather than continuously resizing one another's terminal.
      viewer({ type: 'terminal.resized', sessionId: id, cols: session.screen.cols, rows: session.screen.rows });
      return;
    }
    if (cols === session.screen.cols && rows === session.screen.rows) return;
    session.screen.resize(cols, rows);
    if (session.info.exitCode === null) session.pty.resize(cols, rows);
    this.emit(session, { type: 'terminal.resized', sessionId: id, cols, rows });
  }

  close(workspace: TerminalWorkspace, id: string): void {
    const session = this.session(workspace, id);
    session.closed = true;
    clearTimeout(session.cwdTimer);
    workspace.sessions.delete(id);
    for (const disposable of session.disposables) disposable.dispose();
    if (session.info.exitCode === null) session.pty.kill();
    session.disposeIntegration();
    session.screen.dispose();
    session.listeners.clear();
    if (workspace.activeSessionId === id) workspace.activeSessionId = [...workspace.sessions.keys()].at(-1) ?? null;
    this.changed(workspace);
  }

  dispose(): void {
    for (const workspace of this.workspaces.values()) {
      workspace.listeners.clear();
      for (const id of workspace.sessions.keys()) this.close(workspace, id);
    }
    this.workspaces.clear();
  }

  private session(workspace: TerminalWorkspace, id: string): Session {
    const session = workspace.sessions.get(id);
    if (!session) throw new Error('Terminal does not belong to this workspace.');
    return session;
  }

  private changed(workspace: TerminalWorkspace): void {
    for (const listener of workspace.listeners) listener();
  }

  private emit(session: Session, message: TerminalServerMessage): void {
    for (const listener of session.listeners) listener(message);
  }
}
