import crypto from 'node:crypto';
import { signRelease } from '../desktop/release-signature.mjs';
import { runtimeNames, sha256 } from '../desktop/runtime-package.mjs';

// Test-only keys are generated in memory and never use the publisher key.
export function signedFixture(value) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signRelease(value, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { signed, keys: { [signed.signature.keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
}

export function signedSourceRelease(version, commit = 'a'.repeat(40)) {
  const platform = process.platform === 'win32' ? 'darwin' : 'win32';
  const arch = platform === 'darwin' ? 'arm64' : 'x64';
  const { signed, keys } = signedFixture({ format: 1, repository: 'CoralFlower325/Codex-remote',
    version, commit, platform, arch });
  const bytes = Buffer.from(JSON.stringify(signed));
  const name = runtimeNames(version, platform, arch).manifest;
  const asset = { name, size: bytes.length, digest: `sha256:${sha256(bytes)}`,
    browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/v${version}/${name}` };
  return { signed, keys, bytes, release: { version, tag: `v${version}`, assets: [asset] },
    options: { trustedKeys: keys, fetcher: async () => new Response(bytes) } };
}
