import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compareVersions } from '../desktop/release.mjs';

export function managerReleasePlan(current, previous, changedFiles) {
  const managerChanged = changedFiles.some(name =>
    (name.startsWith('desktop/') && !name.startsWith('desktop/test-fixtures/') &&
      !name.endsWith('.test.mjs') && !name.endsWith('.md')) ||
    ['scripts/build-manager.mjs', 'vite.manager.config.ts'].includes(name));
  if (current === previous && managerChanged) {
    throw new Error('Manager files changed without a manager version increment.');
  }
  if (previous && compareVersions(current, previous) < 0) {
    throw new Error('Manager version must not decrease.');
  }
  return { version: current, package: current !== previous };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const manager = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
  const current = manager.version;
  if (manager.build.publish.url !==
    `https://github.com/CoralFlower325/Codex-remote/releases/download/manager-v${current}`) {
    throw new Error('Packaged manager update URL and version differ.');
  }
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '';
  if (tag && tag !== `manager-v${current}`) throw new Error('Manager tag and package version differ.');
  const previousTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*',
    '--match', 'manager-v[0-9]*', tag ? 'HEAD^' : 'HEAD');
  const previous = previousTag
    ? JSON.parse(git('show', `${previousTag}:desktop/package.json`)).version : null;
  const changes = previousTag ? git('diff', '--name-only', previousTag, 'HEAD').split('\n') : [];
  const plan = managerReleasePlan(current, previous, changes);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `package=${plan.package}\nversion=${plan.version}\n`, 'utf8');
  console.log(JSON.stringify({ ...plan, previousTag: previousTag ?? null }));
}
