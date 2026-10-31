import { managerAssetName } from '../manager-release.mjs';

export function releaseFixture(version = '0.2.2', platform = 'win32', arch = 'x64') {
  const tag_name = `manager-v${version}`;
  return { tag_name, body: '管理器更新摘要', draft: false, prerelease: false,
    assets: [managerAssetName(version, platform, arch), platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml']
      .map(name => ({ name, size: 10, digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/${tag_name}/${name}` })) };
}
