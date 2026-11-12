import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseRepository } from '../desktop/release-identity.mjs';

export { releaseRepository };

const currentVersionDocs = [
  ['README.md', (remote, manager) => [`Remote **${remote}**`, `manager **${manager}**`]],
  ['README.zh-CN.md', (remote, manager) => [`Remote **${remote}**`, `管理器 **${manager}**`]],
  ['docs/guide.md', remote => [`Remote ${remote} pairs`]],
  ['docs/guide.zh-CN.md', remote => [`Remote ${remote} 配套`]],
  ['docs/desktop-manager.md', remote => [`Remote ${remote} pairs`]],
  ['docs/desktop-manager.zh-CN.md', remote => [`Remote ${remote} 配套`]],
  ['docs/maintainer-handoff.md', (remote, manager) => [
    `current published release is Remote **${remote}** / manager **${manager}**`
  ]]
];

export function validateReleaseContract(state, expectedVersion) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  for (const [file, version] of [
    ['package-lock.json', state.remoteVersion],
    ['desktop/package-lock.json', state.managerVersion]
  ]) {
    const lock = state.locks[file];
    check(lock?.version === version, `${file} version mismatch`);
    check(lock?.packages?.['']?.version === version, `${file} root version mismatch`);
  }
  check(state.notes.includes(`version: '${state.remoteVersion}'`),
    'Release notes do not cover the source version');
  check(state.notes.includes(`管理器 ${state.managerVersion}`),
    'Release notes do not identify the manager version');
  for (const [file, patterns] of currentVersionDocs) {
    const text = state.docs[file] ?? '';
    for (const pattern of patterns(state.remoteVersion, state.managerVersion)) {
      check(text.includes(pattern), `${file} current-version drift: missing ${pattern}`);
    }
  }
  check(state.trustedKeyCount > 0, 'No publisher trust root');
  check(state.runtimeWorkflow.includes('secrets.RELEASE_SIGNING_KEY'),
    'Runtime publishing does not require a signing secret');
  check(state.indexCrLfTypeScript.length === 0,
    `TypeScript files must use LF in the Git index: ${state.indexCrLfTypeScript.join(', ')}`);
  if (expectedVersion) {
    check(state.remoteVersion === expectedVersion.replace(/^v/, ''),
      `Release tag ${expectedVersion} does not match package version ${state.remoteVersion}`);
  }
  return failures;
}

export async function loadReleaseContract(root = process.cwd()) {
  const read = file => fs.readFile(path.join(root, file), 'utf8');
  const json = async file => JSON.parse(await read(file));
  const remote = await json('package.json');
  const manager = await json('desktop/package.json');
  const docs = Object.fromEntries(await Promise.all(currentVersionDocs.map(async ([file]) =>
    [file, await read(file)])));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const indexCrLfTypeScript = git(['ls-files', '--eol']).split('\n').filter(row =>
    row.startsWith('i/crlf') && /\t[^\t]+\.tsx?$/.test(row)).map(row => row.split('\t').at(-1));
  const { trustedReleaseKeys } = await import('../desktop/release-keys.mjs');
  return {
    remoteVersion: remote.version,
    managerVersion: manager.version,
    locks: {
      'package-lock.json': await json('package-lock.json'),
      'desktop/package-lock.json': await json('desktop/package-lock.json')
    },
    notes: await read('src/shared/release-notes.ts'),
    docs,
    trustedKeyCount: Object.keys(trustedReleaseKeys).length,
    runtimeWorkflow: await read('.github/workflows/runtime.yml'),
    indexCrLfTypeScript,
    source: git(['rev-parse', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain']))
  };
}
