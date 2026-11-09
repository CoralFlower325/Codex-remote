import { describe, expect, it } from 'vitest';
import { validateReleaseContract } from './release-contract.mjs';

function state() {
  return {
    remoteVersion: '0.2.25',
    managerVersion: '0.2.4',
    locks: {
      'package-lock.json': { version: '0.2.25', packages: { '': { version: '0.2.25' } } },
      'desktop/package-lock.json': { version: '0.2.4', packages: { '': { version: '0.2.4' } } }
    },
    notes: "version: '0.2.25'\n管理器 0.2.4",
    docs: {
      'README.md': 'Remote **0.2.25** manager **0.2.4**',
      'README.zh-CN.md': 'Remote **0.2.25** 管理器 **0.2.4**',
      'docs/guide.md': 'Remote 0.2.25 pairs',
      'docs/guide.zh-CN.md': 'Remote 0.2.25 配套',
      'docs/desktop-manager.md': 'Remote 0.2.25 pairs',
      'docs/desktop-manager.zh-CN.md': 'Remote 0.2.25 配套',
      'docs/maintainer-handoff.md':
        'current published release is Remote **0.2.25** / manager **0.2.4**'
    },
    trustedKeyCount: 1,
    runtimeWorkflow: 'secrets.RELEASE_SIGNING_KEY'
  };
}

describe('release contract', () => {
  it('accepts complete aligned metadata and rejects current-version drift', () => {
    expect(validateReleaseContract(state(), 'v0.2.25')).toEqual([]);
    const drifted = state();
    drifted.docs['docs/guide.md'] = 'Remote 0.2.23 pairs';
    expect(validateReleaseContract(drifted)).toContain(
      'docs/guide.md current-version drift: missing Remote 0.2.25 pairs');
  });

  it('rejects tag, lock, release-note and signing drift', () => {
    const invalid = state();
    invalid.locks['package-lock.json'].version = '0.2.24';
    invalid.notes = "version: '0.2.24'\n管理器 0.2.3";
    invalid.trustedKeyCount = 0;
    invalid.runtimeWorkflow = '';
    expect(validateReleaseContract(invalid, 'v0.2.26')).toEqual(expect.arrayContaining([
      'package-lock.json version mismatch',
      'Release notes do not cover the source version',
      'No publisher trust root',
      'Release tag v0.2.26 does not match package version 0.2.25'
    ]));
  });
});
