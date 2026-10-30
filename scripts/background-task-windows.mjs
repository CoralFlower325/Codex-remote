import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [role, ...args] = process.argv.slice(2);
if (process.platform !== 'win32' || !['server', 'tunnel'].includes(role)) process.exit(2);
const entry = path.join(root, 'dist-server/server',
  role === 'server' ? 'index.js' : 'cli/tunnel-supervisor.js');
const data = path.join(root, 'data');
fs.mkdirSync(data, { recursive: true });
const logs = ['out', 'err'].map((stream) => fs.openSync(path.join(data, `${role}.${stream}.log`), 'a'));
// The windowless task host waits for this child so Task Scheduler retains its
// running state and receives failures for its configured restart policy.
const child = spawn(process.execPath, [entry, ...args], {
  cwd: root, windowsHide: true, stdio: ['ignore', ...logs]
});
logs.forEach((fd) => fs.closeSync(fd));
child.once('error', (error) => {
  fs.appendFileSync(path.join(data, `${role}.err.log`), `${new Date().toISOString()} ${error.message}\n`, 'utf8');
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
