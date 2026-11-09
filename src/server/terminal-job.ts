import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_LIMIT = 4_096;

export interface TerminalJobExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
}

export interface TerminalJobBoundary {
  readonly ready: Promise<void>;
  readonly exited: Promise<TerminalJobExit>;
  stop(): void;
}

export type TerminalJobFactory = (workerPid: number) => TerminalJobBoundary;

function boundedDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-DIAGNOSTIC_LIMIT);
}

export function windowsPowerShellPath(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

class WindowsTerminalJob implements TerminalJobBoundary {
  readonly ready: Promise<void>;
  readonly exited: Promise<TerminalJobExit>;
  private readonly child: ChildProcess;
  private stdout = '';
  private stderr = '';
  private settledReady = false;
  private stopping = false;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private settleReject!: (error: Error) => void;

  constructor(workerPid: number) {
    this.child = spawn(windowsPowerShellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('../../scripts/terminal-job-windows.ps1', import.meta.url)),
      '-WorkerPid', String(workerPid)
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let resolveReady!: () => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      this.settleReject = reject;
    });
    let resolveExit!: (exit: TerminalJobExit) => void;
    this.exited = new Promise<TerminalJobExit>((resolve) => { resolveExit = resolve; });

    this.readyTimer = setTimeout(() => {
      this.failReady(new Error('Windows terminal job did not become ready.'));
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref();

    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.receiveStdout(chunk, resolveReady));
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderr = boundedDiagnostic(`${this.stderr}${chunk}`);
    });
    this.child.once('error', (error) => {
      this.stderr = boundedDiagnostic(`${this.stderr}${error.message}`);
      this.failReady(error);
    });
    this.child.once('close', (code, signal) => {
      clearTimeout(this.readyTimer);
      clearTimeout(this.stopTimer);
      this.failReady(new Error(this.diagnostic('Windows terminal job exited before it was ready.')));
      resolveExit({ code, signal, diagnostic: this.diagnostic('Windows terminal job exited.') });
    });
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.child.stdin?.end('STOP\n');
    this.stopTimer = setTimeout(() => this.child.kill(), STOP_TIMEOUT_MS);
    this.stopTimer.unref();
  }

  private receiveStdout(chunk: string, resolveReady: () => void): void {
    this.stdout = `${this.stdout}${chunk}`;
    for (;;) {
      const boundary = this.stdout.indexOf('\n');
      if (boundary < 0) break;
      const line = this.stdout.slice(0, boundary).trim();
      this.stdout = this.stdout.slice(boundary + 1);
      if (line === 'READY' && !this.settledReady) {
        this.settledReady = true;
        clearTimeout(this.readyTimer);
        resolveReady();
      }
    }
    if (this.stdout.length > DIAGNOSTIC_LIMIT) {
      this.stdout = this.stdout.slice(-DIAGNOSTIC_LIMIT);
    }
  }

  private failReady(error: Error): void {
    if (this.settledReady) return;
    this.settledReady = true;
    clearTimeout(this.readyTimer);
    this.settleReject(new Error(this.diagnostic(error.message)));
  }

  private diagnostic(prefix: string): string {
    return this.stderr ? `${prefix} ${this.stderr}` : prefix;
  }
}

export function createWindowsTerminalJob(workerPid: number): TerminalJobBoundary {
  return new WindowsTerminalJob(workerPid);
}
