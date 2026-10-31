import { describe, expect, it } from 'vitest';
import { latestManagerRelease, managerAssetName, validateManagerRelease } from './manager-release.mjs';

import { releaseFixture } from './test-fixtures/manager-release.mjs';

describe('manager release channel', () => {
  it('ignores Remote and historical combined tags', async () => {
    const data = [{ tag_name: 'v9.0.0' }, releaseFixture('0.2.1')];
    const release = await latestManagerRelease('0.2.0', 'win32', 'x64', async () => Response.json(data));
    expect(release.version).toBe('0.2.1');
    expect(release.available).toBe(true);
    expect(release.asset.name).toContain('0.2.1-win-x64.exe');
  });
  it('preserves equal/newer installed versions without downgrading', async () => {
    for (const version of ['0.2.2', '0.3.0']) {
      expect((await latestManagerRelease(version, 'win32', 'x64',
        async () => Response.json([releaseFixture()]))).available).toBe(false);
    }
  });
  it('follows bounded pages past Remote-only releases', async () => {
    let requests = 0;
    const release = await latestManagerRelease('0.2.0', 'darwin', 'arm64', async () =>
      Response.json(++requests === 1 ? Array.from({ length: 100 }, () => ({ tag_name: 'v9.0.0' }))
        : [releaseFixture('0.2.1', 'darwin', 'arm64')]));
    expect(requests).toBe(2);
    expect(release.asset.name).toMatch(/mac-arm64.zip$/);
  });
  it('chooses the highest version even when older releases were republished later', async () => {
    let page = 0;
    const release = await latestManagerRelease('0.2.0', 'win32', 'x64', async () =>
      Response.json(++page === 1 ? [releaseFixture('0.2.1'),
        ...Array.from({ length: 99 }, () => ({ tag_name: 'v9.0.0' }))] : [releaseFixture('0.3.0')]));
    expect(release.version).toBe('0.3.0');
  });
  it('ignores drafts and prereleases', async () => {
    expect(await latestManagerRelease('0.2.0', 'win32', 'x64', async () =>
      Response.json([{ ...releaseFixture(), draft: true }, { ...releaseFixture(), prerelease: true }]))).toBeNull();
  });
  it('rejects missing/duplicate assets, invalid hashes and foreign URLs', () => {
    const valid = releaseFixture();
    expect(() => validateManagerRelease({ ...valid, assets: [] }, 'win32', 'x64')).toThrow();
    expect(() => validateManagerRelease({ ...valid, assets: [...valid.assets, valid.assets[0]] }, 'win32', 'x64')).toThrow();
    for (const patch of [{ digest: null }, { size: -1 }, { browser_download_url: 'https://example.test/setup.exe' }]) {
      expect(() => validateManagerRelease({ ...valid, assets: [{ ...valid.assets[0], ...patch }, valid.assets[1]] },
        'win32', 'x64')).toThrow();
    }
  });
  it('surfaces network failures and unsupported architectures', async () => {
    await expect(latestManagerRelease('0.2.0', 'win32', 'x64', async () => new Response('', { status: 429 })))
      .rejects.toThrow('429');
    expect(() => managerAssetName('0.2.1', 'darwin', 'x64')).toThrow('Apple Silicon');
  });
});
