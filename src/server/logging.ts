import { Console } from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { boundedLogWriter } from '../../scripts/rotating-log.mjs';

/** Launchd retains its stdout descriptors; application logs open per write. */
export function installRotatingConsole(directory: string, role = 'server'): void {
  if (process.env.CODEX_REMOTE_LOG_CAPTURED === '1') return;
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { /* Keep the service available. */ }
  const stream = (name: string) => {
    const write = boundedLogWriter(path.join(directory, `${role}.${name}.log`));
    return new Writable({ write(chunk: Buffer, _encoding, callback) { write(chunk); callback(); } });
  };
  globalThis.console = new Console({ stdout: stream('out'), stderr: stream('err'), ignoreErrors: false });
}
