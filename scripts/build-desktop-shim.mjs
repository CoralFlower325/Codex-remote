import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const destination = path.resolve('dist/desktop-shim');
await fs.mkdir(destination, { recursive: true });
await fs.copyFile('desktop/shim/desktop-cli-proxy.mjs',
  path.join(destination, 'desktop-cli-proxy.mjs'));
await fs.copyFile('desktop/shim/configure-desktop-shim.ps1',
  path.join(destination, 'configure-desktop-shim.ps1'));

if (process.platform === 'win32') {
  const csc = path.join(process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await fs.access(csc);
  await run(csc, [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    `/out:${path.join(destination, 'codex-remote-cli.exe')}`,
    path.resolve('desktop/shim/CodexRemoteCliShim.cs')
  ], { cwd: path.dirname(csc), windowsHide: true, maxBuffer: 1024 * 1024 });
}
