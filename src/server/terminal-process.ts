import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';

import { createWindowsTerminalJob, type TerminalJobBoundary, type TerminalJobFactory } from './terminal-job.js';

export type TerminalPty = Pick<IPty, 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'onData' | 'onExit'>;
export type TerminalOptions = IPtyForkOptions | IWindowsPtyForkOptions;
export interface TerminalExitEvent {
  exitCode: number;
  signal?: number;
}

const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 4 * 1024;
const WORKER_HARD_TIMEOUT_MS = 4_000;

function boundedDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-STDERR_LIMIT);
}

/** Native PTY faults must terminate one shell, never the Remote process. */
export class TerminalProcess implements TerminalPty {
  private readonly child: ChildProcess;
  private readonly events = new EventEmitter();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly platform: NodeJS.Platform;
  private readonly jobFactory: TerminalJobFactory;
  private readonly startFile: string;
  private readonly startArgs: string[];
  private readonly startOptions: TerminalOptions;
  private job: TerminalJobBoundary | undefined;
  private stderr = '';
  private ready = false;
  private exited = false;
  private closing = false;
  private startSent = false;
  private pending: Array<Record<string, unknown>> = [];
  private queuedBytes = 0;
  private inFlightBytes = 0;
  private inFlightCount = 0;
  private terminateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(file: string, args: string[], options: TerminalOptions, launch = fork,
    jobFactory: TerminalJobFactory = createWindowsTerminalJob, platform = process.platform) {
    const source = import.meta.url.endsWith('.ts');
    this.platform = platform;
    this.jobFactory = jobFactory;
    this.startFile = file;
    this.startArgs = args;
    this.startOptions = options;
    this.child = launch(new URL(source ? './terminal-worker.ts' : './terminal-worker.js', import.meta.url), [], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: source ? ['--import', 'tsx'] : [],
      detached: platform !== 'win32'
    });
    this.timeout = setTimeout(() => this.fail('Terminal worker did not become ready.'), 10_000);
    this.timeout.unref();
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderr = boundedDiagnostic(`${this.stderr}${chunk}`);
    });
    this.child.on('message', message => this.receive(message));
    this.child.once('error', error => this.fail('Terminal worker could not start.', 1, undefined, error.message));
    this.child.once('exit', (code, signal) => {
      this.closeJob();
      this.reapProcessGroup();
      if (!this.exited) {
        this.fail('Terminal worker exited unexpectedly.', typeof code === 'number' ? code : 1, signal);
      } else if (this.terminateTimer) {
        clearTimeout(this.terminateTimer);
        this.terminateTimer = undefined;
      }
    });
    this.child.once('disconnect', () => {
      if (!this.exited) this.fail('Terminal worker disconnected.');
    });

    if (this.platform === 'win32') {
      if (!this.child.pid) {
        queueMicrotask(() => this.fail('Terminal worker has no process id for Windows job isolation.'));
      } else {
        try {
          this.job = this.jobFactory(this.child.pid);
          void this.job.ready.then(
            () => this.start(),
            error => this.fail('Windows terminal job could not attach.', 1, undefined,
              error instanceof Error ? error.message : String(error))
          );
          void this.job.exited.then((exit) => {
            if (!this.exited) {
              this.fail('Windows terminal job exited unexpectedly.', exit.code ?? 1, exit.signal, exit.diagnostic);
            }
          });
        } catch (error) {
          this.fail('Windows terminal job could not be created.', 1, undefined,
            error instanceof Error ? error.message : String(error));
        }
      }
    } else {
      queueMicrotask(() => this.start());
    }
  }

  onData(listener: (data: string) => void): IDisposable {
    this.events.on('data', listener);
    return { dispose: () => this.events.off('data', listener) };
  }
  onExit(listener: (event: TerminalExitEvent) => void): IDisposable {
    this.events.on('exit', listener);
    return { dispose: () => this.events.off('exit', listener) };
  }
  write(data: string): void {
    const bytes = Buffer.byteLength(data);
    if (bytes > 64 * 1024) throw new Error('Terminal input is too large.');
    this.command({ type: 'input', data }, bytes);
  }
  resize(cols: number, rows: number): void { this.command({ type: 'resize', cols, rows }); }
  pause(): void { this.command({ type: 'pause' }); }
  resume(): void { this.command({ type: 'resume' }); }
  kill(): void {
    if (this.exited || this.closing) return;
    this.closing = true;
    this.pending = [];
    this.queuedBytes = 0;
    this.transmit({ type: 'kill' });
    this.scheduleTermination();
  }

  private finish(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.timeout);
    this.pending = [];
    this.queuedBytes = 0;
    this.events.emit('exit', { exitCode, ...(signal === undefined ? {} : { signal }) });
    // The worker keeps the job alive while ConPTY and the shell tree drain.
    this.scheduleTermination();
  }

  private start(): void {
    if (this.startSent || this.closing || this.exited) return;
    this.startSent = true;
    this.transmit({ type: 'start', file: this.startFile, args: this.startArgs, options: this.startOptions });
  }

  private scheduleTermination(): void {
    if (this.terminateTimer) return;
    this.terminateTimer = setTimeout(() => {
      this.terminateTimer = undefined;
      this.forceReap();
    }, WORKER_HARD_TIMEOUT_MS);
    this.terminateTimer.unref();
  }

  private forceReap(): void {
    this.closeJob();
    if (this.platform === 'win32') {
      this.child.kill();
      return;
    }
    this.reapProcessGroup();
  }

  private reapProcessGroup(): void {
    const pid = this.child.pid;
    if (this.platform === 'win32') return;
    if (!pid) {
      try { this.child.kill('SIGKILL'); } catch { /* Already gone. */ }
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { this.child.kill('SIGKILL'); } catch { /* Already gone. */ }
    }
  }

  private closeJob(): void {
    this.job?.stop();
    this.job = undefined;
  }

  private command(message: Record<string, unknown>, bytes = 0): void {
    if (this.exited || this.closing) throw new Error('Terminal has exited.');
    if (this.queuedBytes + this.inFlightBytes + bytes > INPUT_LIMIT || this.pending.length + this.inFlightCount >= 1024) {
      throw new Error('Terminal input is busy; wait before sending more.');
    }
    if (!this.ready) { this.pending.push(message); this.queuedBytes += bytes; }
    else this.transmit(message, bytes);
  }

  private transmit(message: Record<string, unknown>, bytes = 0) {
    if (this.exited || !this.child.connected) return;
    this.inFlightBytes += bytes;
    this.inFlightCount++;
    try {
      this.child.send(message, error => {
        this.inFlightBytes -= bytes;
        this.inFlightCount--;
        if (error && !this.exited) this.fail('Terminal IPC write failed.');
      });
    } catch {
      this.inFlightBytes -= bytes;
      this.inFlightCount--;
      this.fail('Terminal IPC write failed.');
    }
  }

  private receive(value: unknown) {
    if (this.exited) return;
    if (!value || typeof value !== 'object' || !('type' in value)) return this.fail('Invalid terminal worker response.');
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') {
      clearTimeout(this.timeout);
      this.ready = true;
      const pending = this.pending;
      this.pending = [];
      this.queuedBytes = 0;
      if (!this.closing) {
        for (const item of pending) {
          this.transmit(item, typeof item.data === 'string' ? Buffer.byteLength(item.data) : 0);
        }
      }
    } else if (message.type === 'data' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= OUTPUT_LIMIT) {
      this.events.emit('data', message.data);
      this.transmit({ type: 'ack', size: Buffer.byteLength(message.data) });
    } else if (message.type === 'exit' && Number.isInteger(message.exitCode)) {
      this.finish(message.exitCode as number,
        typeof message.signal === 'number' ? message.signal : undefined);
    } else this.fail('Terminal worker failed.');
  }

  private fail(message: string, exitCode = 1, signal?: string | number | null, detail = ''): void {
    if (this.exited) return;
    const parts = [message];
    if (exitCode !== 1 || signal) parts.push(`exit=${exitCode}`);
    if (signal) parts.push(`signal=${signal}`);
    const captured = boundedDiagnostic(`${detail} ${this.stderr}`);
    if (captured) parts.push(`diagnostic=${captured.slice(0, 1_024)}`);
    this.events.emit('data', `\r\n[${parts.join('; ')} Open a new terminal explicitly to continue.]\r\n`);
    this.finish(exitCode, typeof signal === 'number' ? signal : undefined);
    this.closeJob();
    this.forceReap();
  }
}

export const spawnTerminal = (file: string, args: string[], options: TerminalOptions): TerminalPty =>
  new TerminalProcess(file, args, options);
