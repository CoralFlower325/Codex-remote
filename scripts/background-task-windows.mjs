import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { boundedLogWriter } from './rotating-log.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [role, ...args] = process.argv.slice(2);
if (process.platform !== 'win32' || !['server', 'tunnel'].includes(role)) process.exit(2);
const entry = path.join(root, 'dist-server/server',
  role === 'server' ? 'index.js' : 'cli/tunnel-supervisor.js');
const data = path.join(root, 'data');
try { fs.mkdirSync(data, { recursive: true }); } catch { /* Keep the owned child running if logging is unavailable. */ }
const out = boundedLogWriter(path.join(data, `${role}.out.log`));
const err = boundedLogWriter(path.join(data, `${role}.err.log`));
// The windowless task host waits for this child so Task Scheduler retains its
// running state and receives failures for its configured restart policy.
const child = spawn(process.execPath, [entry, ...args], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', out);
child.stderr.on('data', err);
child.once('error', (error) => {
  err(`${new Date().toISOString()} ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
