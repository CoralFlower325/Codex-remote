import type { IPty, IPtyForkOptions } from 'node-pty';
import { createRequire } from 'node:module';

let pty: IPty | undefined;
let starting = false;
let closed = false;
let paused = false;
let outstanding = 0;
let messages = 0;
const LIMIT = 1024 * 1024;
function send(message: unknown, callback?: () => void) {
  if (!process.connected || !process.send) return terminate();
  try {
    process.send(message as object, error => {
      if (error) terminate();
      else callback?.();
    });
  } catch { terminate(); }
}
function terminate() {
  if (closed) return;
  closed = true;
  try { pty?.kill(); } finally { process.exit(1); }
}
function finish(exitCode: number) {
  if (closed) return;
  closed = true;
  send({ type: 'exit', exitCode }, () => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('disconnect', terminate);
process.on('message', async value => {
  try {
    if (!value || typeof value !== 'object' || !('type' in value)) return terminate();
    const message = value as Record<string, unknown>;
    if (message.type === 'kill') return terminate();
    if (message.type === 'start') {
      if (starting || typeof message.file !== 'string' || !Array.isArray(message.args) ||
        !message.options || typeof message.options !== 'object') return terminate();
      starting = true;
      const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
      if (closed) return;
      pty = native.spawn(message.file, message.args as string[], message.options as IPtyForkOptions);
      pty.onData(data => {
        outstanding += Buffer.byteLength(data);
        messages++;
        if (outstanding > LIMIT || messages > 4096) return terminate();
        if (outstanding > 128 * 1024 || messages > 1024) pty?.pause();
        send({ type: 'data', data });
      });
      pty.onExit(({ exitCode }) => finish(exitCode));
      send({ type: 'ready' });
      return;
    }
    if (!pty || closed) return terminate();
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
    } else terminate();
  } catch (error) {
    send({ type: 'data', data: `\r\n[Terminal worker error: ${error instanceof Error ? error.message : String(error)}]\r\n` });
    finish(1);
  }
});
