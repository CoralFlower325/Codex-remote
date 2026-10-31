import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

if (!process.env.npm_execpath) throw new Error('Run this command through npm run runtime:prune.');
const lock = await fs.readFile('package-lock.json');
try {
  execFileSync(process.execPath, [process.env.npm_execpath, 'prune', '--omit=dev',
    '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 600_000 });
} finally {
  // npm 10 rewrites lockfile metadata while pruning. Ship the exact reviewed
  // lockfile; dependency selection still uses it, including optional natives.
  await fs.writeFile('package-lock.json', lock);
}
