import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function managerReleasePlan(current, previous, changedFiles) {
  const managerChanged = changedFiles.some(name =>
    (name.startsWith('desktop/') && !name.endsWith('.test.mjs') && !name.endsWith('.md')) ||
    ['scripts/build-manager.mjs', 'vite.manager.config.ts'].includes(name));
  if (current === previous && managerChanged) {
    throw new Error('Manager files changed without a manager version increment.');
  }
  return { version: current, package: current !== previous };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const current = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8')).version;
  const remote = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const previousTag = git('tag', '--merged', 'HEAD', '--sort=-v:refname').split('\n')
    .find(tag => /^v\d+\.\d+\.\d+$/.test(tag) && tag !== `v${remote}`);
  const previous = previousTag
    ? JSON.parse(git('show', `${previousTag}:desktop/package.json`)).version : null;
  const changes = previousTag ? git('diff', '--name-only', previousTag, 'HEAD').split('\n') : [];
  const plan = managerReleasePlan(current, previous, changes);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `package=${plan.package}\nversion=${plan.version}\n`, 'utf8');
  console.log(JSON.stringify({ ...plan, previousTag: previousTag ?? null }));
}
