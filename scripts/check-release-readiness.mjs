import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadReleaseContract, validateReleaseContract } from './release-contract.mjs';

const allowDirty = process.argv.includes('--allow-dirty') || process.env.RELEASE_ALLOW_DIRTY === '1';
const expectedVersion = process.env.GITHUB_REF_TYPE === 'tag' ||
  /^v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME ?? '')
  ? process.env.GITHUB_REF_NAME : undefined;
const state = await loadReleaseContract();
const failures = validateReleaseContract(state, expectedVersion);
if (state.dirty && !allowDirty) {
  failures.push('Working tree is dirty; commit or pass --allow-dirty for a development receipt');
}
assert.deepEqual(failures, [], failures.join('\n'));
const receipt = {
  checkedAt: new Date().toISOString(),
  source: state.source,
  dirty: state.dirty,
  remote: state.remoteVersion,
  manager: state.managerVersion,
  state: 'source-consistent',
  published: false,
  distributionVerified: false,
  installed: false,
  signingSecretProvisioned: 'not-verified',
  physicalDeviceAcceptance: 'pending'
};
await fs.mkdir('output/acceptance', { recursive: true });
await fs.writeFile('output/acceptance/release-readiness.json', JSON.stringify(receipt, null, 2), 'utf8');
console.log(JSON.stringify(receipt, null, 2));
console.log('Source metadata is consistent. This check does not publish, deploy or establish an installed version.');
