import { compareVersions, versionPattern } from './release.mjs';

const repository = 'CoralFlower325/Codex-remote';
const api = `https://api.github.com/repos/${repository}/releases`;
export const managerTagPattern = /^manager-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function managerAssetName(version, platform, arch) {
  if (!versionPattern.test(version) || version.startsWith('v')) throw new Error('管理器版本格式无效。');
  if (platform === 'win32' && arch === 'x64') return `Codex-Remote-Manager-${version}-win-x64.exe`;
  if (platform === 'darwin' && arch === 'arm64') return `Codex-Remote-Manager-${version}-mac-arm64.zip`;
  throw new Error('管理器自更新仅支持 Windows x64 和 Apple Silicon。');
}

export function validateManagerRelease(release, platform, arch) {
  const version = managerTagPattern.exec(release?.tag_name)?.[1];
  if (!version || release.draft || release.prerelease) throw new Error('管理器正式发布信息无效。');
  const filename = managerAssetName(version, platform, arch);
  const metadata = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  const baseUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const verified = [filename, metadata].map(name => {
    const matches = assets.filter(asset => asset.name === name);
    if (matches.length !== 1) throw new Error(`管理器发布缺少唯一附件：${name}`);
    const asset = matches[0];
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3 ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || asset.browser_download_url !== baseUrl + name) {
      throw new Error(`管理器附件来源或摘要无效：${name}`);
    }
    return { name, size: asset.size, sha256: asset.digest.slice(7), url: asset.browser_download_url };
  });
  return { version, tag: release.tag_name, notes: String(release.body || '').slice(0, 16_000),
    baseUrl, asset: verified[0], metadata: verified[1] };
}

export async function latestManagerRelease(installedVersion, platform, arch, fetcher = fetch, cancellation) {
  managerAssetName(installedVersion, platform, arch);
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(cancellation ? [cancellation] : [])]);
  const candidates = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(`${api}?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json' }, signal, redirect: 'error'
    });
    if (!response.ok) throw new Error(`读取管理器发布失败（HTTP ${response.status}）。`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('管理器发布列表格式无效。');
    candidates.push(...releases.filter(release => !release.draft && !release.prerelease &&
      managerTagPattern.test(release.tag_name)));
    if (releases.length < 100) {
      if (!candidates.length) return null;
      candidates.sort((a, b) => compareVersions(b.tag_name.slice(9), a.tag_name.slice(9)));
      const release = validateManagerRelease(candidates[0], platform, arch);
      return { ...release, available: compareVersions(release.version, installedVersion) > 0 };
    }
  }
  throw new Error('近期发布中未找到管理器版本，请稍后重试或查看管理器发布页。');
}
