import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundedLogWriter } from './rotating-log.mjs';

const entry = process.argv[2];
if (!entry || !path.isAbsolute(entry)) process.exit(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.argv = [process.argv[0], entry, ...process.argv.slice(3)];
let directory = path.resolve(process.env.DATA_DIR?.trim() || 'data');
const writers = new Map();
function write(name, chunk) {
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { /* Logging must not stop the service. */ }
  const file = path.join(directory, `server.${name}.log`);
  let writer = writers.get(file);
  if (!writer) { writer = boundedLogWriter(file); writers.set(file, writer); }
  writer(chunk);
}
for (const [stream, name] of [[process.stdout, 'out'], [process.stderr, 'err']]) {
  stream.write = (chunk, encoding, callback) => {
    write(name, typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
}
process.env.CODEX_REMOTE_LOG_CAPTURED = '1';
process.on('uncaughtExceptionMonitor', error => write('err', `${error.stack || error}\n`));
try {
  await import('dotenv/config');
  directory = path.resolve(process.env.DATA_DIR?.trim() || 'data');
  await import(pathToFileURL(entry).href);
} catch (error) {
  write('err', `${error.stack || error}\n`);
  process.exitCode = 1;
}
