import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { trustedReleaseKeys } from '../desktop/release-keys.mjs';

const read = file => fs.readFile(file, 'utf8');
const json = async file => JSON.parse(await read(file));
const remote = await json('package.json');
const manager = await json('desktop/package.json');
for (const [file, version] of [['package-lock.json', remote.version], ['desktop/package-lock.json', manager.version]]) {
  const lock = await json(file);
  assert.equal(lock.version, version, `${file} version mismatch`);
  assert.equal(lock.packages[''].version, version, `${file} root version mismatch`);
}
const notes = await read('src/shared/release-notes.ts');
assert.ok(notes.includes(`version: '${remote.version}'`), 'Release notes do not cover the source version');
assert.ok(notes.includes(`管理器 ${manager.version}`), 'Release notes do not identify the manager version');
for (const file of ['README.md', 'README.zh-CN.md']) {
  const text = await read(file);
  assert.ok(text.includes(`**${remote.version}`), `${file} remote version drift`);
  assert.ok(text.includes(`**${manager.version}`), `${file} manager version drift`);
}
assert.ok(Object.keys(trustedReleaseKeys).length > 0, 'No publisher trust root');
assert.ok((await read('.github/workflows/runtime.yml')).includes('secrets.RELEASE_SIGNING_KEY'),
  'Runtime publishing does not require a signing secret');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
const receipt = { checkedAt: new Date().toISOString(), source, dirty, remote: remote.version, manager: manager.version,
  state: 'source-consistent', published: false, distributionVerified: false, installed: false,
  signingSecretProvisioned: 'not-verified', physicalDeviceAcceptance: 'pending' };
await fs.mkdir('output/acceptance', { recursive: true });
await fs.writeFile('output/acceptance/release-readiness.json', JSON.stringify(receipt, null, 2), 'utf8');
console.log(JSON.stringify(receipt, null, 2));
console.log('Source metadata is consistent. This check does not publish, deploy or establish an installed version.');
