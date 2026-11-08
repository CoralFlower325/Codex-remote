import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';

export type TerminalPty = Pick<IPty, 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'onData' | 'onExit'>;
export type TerminalOptions = IPtyForkOptions | IWindowsPtyForkOptions;
const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;

/** Native PTY faults must terminate one shell, never the Remote process. */
export class TerminalProcess implements TerminalPty {
  private readonly child: ChildProcess;
  private readonly events = new EventEmitter();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private ready = false;
  private exited = false;
  private closing = false;
  private pending: Array<Record<string, unknown>> = [];
  private queuedBytes = 0;
  private inFlightBytes = 0;
  private inFlightCount = 0;
  private terminateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(file: string, args: string[], options: TerminalOptions, launch = fork) {
    const source = import.meta.url.endsWith('.ts');
    this.child = launch(new URL(source ? './terminal-worker.ts' : './terminal-worker.js', import.meta.url), [], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: source ? ['--import', 'tsx'] : []
    });
    this.timeout = setTimeout(() => this.fail('Terminal worker did not become ready.'), 10_000);
    this.timeout.unref();
    this.child.on('message', message => this.receive(message));
    this.child.once('error', () => this.fail('Terminal worker could not start.'));
    this.child.once('exit', code => this.fail('Terminal worker exited unexpectedly.',
      typeof code === 'number' && code !== 0 ? code : 1));
    this.child.once('disconnect', () => { if (!this.exited) this.fail('Terminal worker disconnected.'); });
    // The manager installs data/exit listeners immediately after construction.
    // Defer IPC so even a synchronous send failure reaches those listeners.
    queueMicrotask(() => { if (!this.closing) this.transmit({ type: 'start', file, args, options }); });
  }

  onData(listener: (data: string) => void): IDisposable {
    this.events.on('data', listener);
    return { dispose: () => this.events.off('data', listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable {
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
  private scheduleTermination() {
    if (this.terminateTimer) return;
    this.terminateTimer = setTimeout(() => this.child.kill(), 2000);
    this.terminateTimer.unref();
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
    } catch { this.inFlightBytes -= bytes; this.inFlightCount--; this.fail('Terminal IPC write failed.'); }
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
      if (!this.closing) for (const message of pending) this.transmit(message, typeof message.data === 'string' ? Buffer.byteLength(message.data) : 0);
    } else if (message.type === 'data' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= OUTPUT_LIMIT) {
      this.events.emit('data', message.data);
      this.transmit({ type: 'ack', size: Buffer.byteLength(message.data) });
    } else if (message.type === 'exit' && Number.isInteger(message.exitCode)) {
      this.finish(message.exitCode as number);
    } else this.fail('Terminal worker failed.');
  }
  private fail(message: string, exitCode = 1) {
    if (this.exited) return;
    this.events.emit('data', `\r\n[${message} Open a new terminal explicitly to continue.]\r\n`);
    this.finish(exitCode);
    this.child.kill();
  }
  private finish(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.timeout);
    if (this.terminateTimer) clearTimeout(this.terminateTimer);
    this.pending = [];
    this.queuedBytes = 0;
    this.events.emit('exit', { exitCode });
  }
}

export const spawnTerminal = (file: string, args: string[], options: TerminalOptions): TerminalPty =>
  new TerminalProcess(file, args, options);
