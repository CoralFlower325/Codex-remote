const repository = 'CoralFlower325/Codex-remote';
export const distributionOrigin = 'https://downloads.73916482.xyz';
export const releaseEndpoints = [
  `${distributionOrigin}/releases/latest`,
  `https://api.github.com/repos/${repository}/releases/latest`
];

export function assetEndpoints(asset) {
  const url = new URL(asset.browser_download_url);
  const prefix = `/${repository}/releases/download/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
    url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix) ||
    !/^v?\d+\.\d+\.\d+\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname.slice(prefix.length))) {
    throw new Error('运行包下载地址无效。');
  }
  return [`${distributionOrigin}/releases/download/${url.pathname.slice(prefix.length)}`, url.href];
}
