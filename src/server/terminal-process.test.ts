import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TerminalProcess } from './terminal-process.js';

class Worker extends EventEmitter {
  connected = true;
  sent: Array<Record<string, unknown>> = [];
  callbacks: Array<(error?: Error | null) => void> = [];
  kill = vi.fn(() => true);
  send(message: Record<string, unknown>, callback: (error?: Error | null) => void) {
    this.sent.push(message);
    this.callbacks.push(callback);
    return true;
  }
}
function setup() {
  const worker = new Worker();
  const launch = vi.fn(() => worker);
  const pty = new TerminalProcess('fixture-shell', [], { cwd: process.cwd(), cols: 80, rows: 24 }, launch as never);
  return { worker, launch, pty };
}

describe('isolated terminal process', () => {
  it('queues initial input and geometry until the worker is ready and acknowledges output', async () => {
    const { worker, launch, pty } = setup();
    const output = vi.fn();
    pty.onData(output);
    pty.write('initial command\r');
    pty.resize(100, 30);
    await Promise.resolve();
    expect(worker.sent.map(message => message.type)).toEqual(['start']);
    worker.emit('message', { type: 'ready' });
    expect(worker.sent.slice(1)).toEqual([
      { type: 'input', data: 'initial command\r' }, { type: 'resize', cols: 100, rows: 30 }
    ]);
    worker.emit('message', { type: 'data', data: 'output' });
    expect(output).toHaveBeenCalledWith('output');
    expect(worker.sent.at(-1)).toEqual({ type: 'ack', size: 6 });
    expect(launch).toHaveBeenCalledWith(expect.any(URL), [], expect.objectContaining({
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }));
    worker.emit('message', { type: 'exit', exitCode: 7 });
    worker.emit('exit', 0);
  });

  it('contains worker crashes, marks one shell exited and never restarts or replays input', async () => {
    const { worker, launch, pty } = setup();
    const output = vi.fn();
    const exit = vi.fn();
    pty.onData(output);
    pty.onExit(exit);
    pty.write('pending command\r');
    await Promise.resolve();
    worker.emit('exit', 42);
    worker.emit('disconnect');
    expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 42 });
    expect(output).toHaveBeenCalledWith(expect.stringContaining('new terminal explicitly'));
    expect(launch).toHaveBeenCalledOnce();
    expect(worker.sent.map(message => message.type)).toEqual(['start']);
    expect(() => pty.write('do not replay')).toThrow('exited');
  });

  it('caps queued input before readiness and IPC input awaiting delivery', async () => {
    const { worker, pty } = setup();
    await Promise.resolve();
    for (let count = 0; count < 4; count++) pty.write('x'.repeat(64 * 1024));
    expect(() => pty.write('overflow')).toThrow('busy');
    worker.emit('message', { type: 'ready' });
    expect(() => pty.write('overflow')).toThrow('busy');
    for (const callback of worker.callbacks.splice(0)) callback();
    pty.write('accepted after drain');
    expect(worker.sent.at(-1)).toMatchObject({ type: 'input', data: 'accepted after drain' });
    worker.emit('message', { type: 'exit', exitCode: 0 });
  });

  it('limits rapid control messages even when their payloads have no input bytes', async () => {
    const { worker, pty } = setup();
    await Promise.resolve();
    worker.emit('message', { type: 'ready' });
    for (let count = 0; count < 1023; count++) pty.resize(80, 24);
    expect(() => pty.resize(80, 24)).toThrow('busy');
    worker.emit('message', { type: 'exit', exitCode: 0 });
  });

  it('reports immediate IPC startup failure after listeners are installed', async () => {
    const worker = new Worker();
    worker.send = () => { throw new Error('IPC closed during spawn'); };
    const pty = new TerminalProcess('fixture-shell', [], {}, vi.fn(() => worker) as never);
    const exit = vi.fn();
    pty.onExit(exit);
    await Promise.resolve();
    expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 1 });
    expect(worker.kill).toHaveBeenCalledOnce();
  });
});
