import type { IPty, IPtyForkOptions } from 'node-pty';
import { createRequire } from 'node:module';

let pty: IPty | undefined;
let starting = false;
let closing = false;
let paused = false;
let outstanding = 0;
let messages = 0;
let hardExitTimer: ReturnType<typeof setTimeout> | undefined;
const LIMIT = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 3_000;

function send(message: unknown, callback?: () => void): boolean {
  if (!process.connected || !process.send) return false;
  try {
    process.send(message as object, error => {
      if (error) shutdown(1);
      else callback?.();
    });
    return true;
  } catch {
    return false;
  }
}

function releasePty(): void {
  const native = pty;
  pty = undefined;
  if (!native) return;
  try { native.kill(); } catch { /* The shell may already be gone. */ }
}

/**
 * Keep the worker alive long enough for node-pty to release ConPTY handles.
 * The event loop performs a graceful exit when those handles close; the hard
 * timer is the bounded fallback for a stuck native cleanup.
 */
function shutdown(exitCode: number, signal?: string | number, report = true): void {
  if (closing) return;
  closing = true;
  releasePty();
  process.exitCode = exitCode;
  hardExitTimer = setTimeout(() => process.exit(exitCode), CLEANUP_TIMEOUT_MS);
  hardExitTimer.unref();

  const leave = () => {
    try { process.disconnect?.(); } catch { /* Parent already disconnected. */ }
  };
  if (!report || !send({
    type: 'exit',
    exitCode,
    ...(signal === undefined ? {} : { signal })
  }, leave)) {
    leave();
  }
}

process.on('disconnect', () => shutdown(1, undefined, false));
process.on('message', async value => {
  try {
    if (closing) return;
    if (!value || typeof value !== 'object' || !('type' in value)) return shutdown(1);
    const message = value as Record<string, unknown>;
    if (message.type === 'kill') return shutdown(0);
    if (message.type === 'start') {
      if (starting || typeof message.file !== 'string' || !Array.isArray(message.args) ||
        !message.options || typeof message.options !== 'object') return shutdown(1);
      starting = true;
      const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
      if (closing) return;
      pty = native.spawn(message.file, message.args as string[], message.options as IPtyForkOptions);
      pty.onData(data => {
        if (closing) return;
        outstanding += Buffer.byteLength(data);
        messages++;
        if (outstanding > LIMIT || messages > 4096) return shutdown(1);
        if (outstanding > 128 * 1024 || messages > 1024) pty?.pause();
        if (!send({ type: 'data', data })) shutdown(1);
      });
      pty.onExit(({ exitCode, signal }) => shutdown(exitCode, signal));
      if (!send({ type: 'ready' })) shutdown(1);
      return;
    }
    if (!pty || closing) return shutdown(1);
    if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= 64 * 1024) {
      pty.write(message.data);
    } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) &&
      Number(message.cols) >= 2 && Number(message.cols) <= 500 && Number(message.rows) >= 1 && Number(message.rows) <= 300) {
      pty.resize(Number(message.cols), Number(message.rows));
    } else if (message.type === 'pause') { paused = true; pty.pause(); }
    else if (message.type === 'resume') { paused = false; if (outstanding < 32 * 1024 && messages < 256) pty.resume(); }
    else if (message.type === 'ack' && Number.isSafeInteger(message.size) && Number(message.size) > 0) {
      outstanding = Math.max(0, outstanding - Number(message.size));
      messages = Math.max(0, messages - 1);
      if (!paused && outstanding < 32 * 1024 && messages < 256) pty.resume();
    } else shutdown(1);
  } catch (error) {
    send({
      type: 'data',
      data: `\r\n[Terminal worker error: ${error instanceof Error ? error.message : String(error)}]\r\n`
    });
    shutdown(1);
  }
});
