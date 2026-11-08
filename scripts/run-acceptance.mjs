import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const groups = {
  browser: ['check-audit-ui.mjs', 'check-composer-layout.mjs', 'check-review-followup.mjs', 'check-web-update.mjs', 'check-preview-security.mjs'],
  'windows-worker': ['check-web-update-worker.mjs']
};
const group = process.argv[2] ?? 'browser';
if (!(group in groups)) throw new Error(`Unknown acceptance group: ${group}`);
if (group === 'windows-worker' && process.platform !== 'win32')
  throw new Error('The Windows worker acceptance must run on Windows.');
const results = [];
await fs.mkdir('output/acceptance', { recursive: true });
for (const script of groups[group]) {
  const startedAt = Date.now();
  console.log(`Running isolated acceptance: ${script}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}`], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  results.push({ script, code, elapsedMs: Date.now() - startedAt });
  await fs.writeFile(`output/acceptance/${group}.json`, JSON.stringify(results, null, 2), 'utf8');
  if (code !== 0) process.exit(code);
}
