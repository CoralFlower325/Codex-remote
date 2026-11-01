import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'CoralFlower325/Codex-remote';
const version = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const filename = new RegExp(`^(?:codex-remote-runtime-${version}-(?:win32-x64|darwin-arm64)\\.(?:json|tar\\.gz)|Codex-Remote-Manager-${version}-(?:win-x64\\.exe|mac-arm64\\.(?:dmg|zip)))$`);

export function checkedReleaseSnapshot(value) {
  const data = value?.release ?? value;
  if (data?.draft !== false || data.prerelease !== false || !new RegExp(`^v${version}$`).test(data.tag_name) ||
    !Array.isArray(data.assets) || data.assets.length > 50) throw new Error('Invalid stable release snapshot.');
  const names = new Set();
  const assets = data.assets.filter(asset => filename.test(asset.name)).map(asset => {
    const url = new URL(asset.browser_download_url);
    if (url.href !== `https://github.com/${repository}/releases/download/${data.tag_name}/${asset.name}` ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024 ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || names.has(asset.name)) {
      throw new Error('Invalid official release asset metadata.');
    }
    names.add(asset.name);
    return { name: asset.name, size: asset.size, digest: asset.digest, browser_download_url: url.href };
  });
  for (const platform of ['win32-x64', 'darwin-arm64']) {
    for (const extension of ['json', 'tar.gz']) {
      if (!names.has(`codex-remote-runtime-${data.tag_name.slice(1)}-${platform}.${extension}`)) {
        throw new Error('Both platform runtime pairs must finish publishing before snapshot refresh.');
      }
    }
  }
  const release = { tag_name: data.tag_name, draft: false, prerelease: false,
    body: String(data.body || '').slice(0, 16_000), assets };
  const generatedAt = value?.release ? value.generatedAt : new Date().toISOString();
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) throw new Error('Invalid snapshot timestamp.');
  return { generatedAt, release };
}

export async function refreshDistributionRelease(input) {
  // gh handles its existing local authentication; no credential is copied into the Worker.
  const text = input ? await fs.readFile(path.resolve(input), 'utf8')
    : execFileSync('gh', ['api', `repos/${repository}/releases/latest`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Release metadata is too large.');
  const snapshot = checkedReleaseSnapshot(JSON.parse(text));
  const output = path.join(project, 'distribution/.cloudflare/release-snapshot.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(snapshot), 'utf8');
  console.log(JSON.stringify({ snapshot: output, tag: snapshot.release.tag_name,
    assets: snapshot.release.assets.length, generatedAt: snapshot.generatedAt }));
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await refreshDistributionRelease(process.argv[2]);
}
