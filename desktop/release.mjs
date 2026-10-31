const api = 'https://api.github.com/repos/CoralFlower325/Codex-remote/releases/latest';
export const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a, b) {
  const x = versionPattern.exec(a); const y = versionPattern.exec(b);
  if (!x || !y) throw new Error('Unsupported version format.');
  for (let i = 1; i < 4; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1;
  return 0;
}

export async function latestRelease(installedVersion, fetcher = fetch) {
  const response = await fetcher(api, { headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Release check failed (HTTP ${response.status}).`);
  const data = await response.json();
  if (!versionPattern.test(data.tag_name) || data.draft || data.prerelease) throw new Error('Invalid stable release.');
  return { version: data.tag_name.replace(/^v/, ''), tag: data.tag_name,
    notes: String(data.body || '').slice(0, 16_000),
    assets: Array.isArray(data.assets) ? data.assets.map(({ name, size, digest, browser_download_url }) =>
      ({ name, size, digest, browser_download_url })) : [],
    available: compareVersions(data.tag_name, installedVersion) > 0 };
}

