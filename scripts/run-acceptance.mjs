import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const groups = {
  browser: ['check-audit-ui.mjs', 'check-composer-layout.mjs', 'check-review-followup.mjs', 'check-web-update.mjs', 'check-preview-security.mjs'],
  'windows-worker': ['check-web-update-worker.mjs']
};
const group = process.argv[2] ?? 'browser';
const timeoutMs = Number(process.env.ACCEPTANCE_TIMEOUT_MS || 900_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error('ACCEPTANCE_TIMEOUT_MS must be at least 1000.');
if (!(group in groups)) throw new Error(`Unknown acceptance group: ${group}`);
if (group === 'windows-worker' && process.platform !== 'win32')
  throw new Error('The Windows worker acceptance must run on Windows.');
const results = [];
await fs.mkdir('output/acceptance', { recursive: true });
for (const script of groups[group]) {
  const startedAt = Date.now();
  console.log(`Running isolated acceptance: ${script}`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}`], { stdio: 'inherit', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
      } else {
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
      }
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? (signal ? 1 : 0), signal, timedOut });
    });
  });
  results.push({ script, ...result, elapsedMs: Date.now() - startedAt });
  await fs.writeFile(`output/acceptance/${group}.json`, JSON.stringify(results, null, 2), 'utf8');
  if (result.code !== 0) process.exit(result.code);
}
