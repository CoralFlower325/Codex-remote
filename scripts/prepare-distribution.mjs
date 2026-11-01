import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedReleaseSnapshot } from './refresh-distribution-release.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, 'distribution');
const hostname = process.env.REMOTE_DOWNLOAD_HOST;
const zone = process.env.REMOTE_DOWNLOAD_ZONE;
if (!hostname || !zone || !/^[a-z0-9.-]+$/.test(hostname) || !/^[a-z0-9.-]+$/.test(zone) ||
  !hostname.endsWith(`.${zone}`)) {
  throw new Error('Set REMOTE_DOWNLOAD_HOST and REMOTE_DOWNLOAD_ZONE to the download hostname and zone.');
}
const output = path.resolve(root, '.cloudflare/output');
if (path.relative(root, output) !== path.join('.cloudflare', 'output')) throw new Error('Invalid build output.');
const snapshotFile = process.env.REMOTE_DOWNLOAD_METADATA || path.join(root, '.cloudflare/release-snapshot.json');
const snapshot = checkedReleaseSnapshot(JSON.parse(await fs.readFile(snapshotFile, 'utf8')));
await fs.rm(output, { recursive: true, force: true });
const target = path.join(output, 'v0/workers/default');
await fs.mkdir(path.join(target, 'bundle'), { recursive: true });
await fs.copyFile(path.join(root, 'worker.mjs'), path.join(target, 'bundle/distribution.mjs'));
await fs.writeFile(path.join(target, 'bundle/release-snapshot.mjs'), `export default ${JSON.stringify(snapshot)};\n`, 'utf8');
await fs.writeFile(path.join(target, 'bundle/worker.mjs'),
  "import { handleDistribution } from './distribution.mjs';\nimport snapshot from './release-snapshot.mjs';\n" +
  "export default { fetch(request) { return handleDistribution(request, { cache: caches.default, snapshot }); } };\n", 'utf8');
await fs.writeFile(path.join(output, 'v0/config.json'), JSON.stringify({ buildContext: { isPreview: false } }), 'utf8');
await fs.writeFile(path.join(target, 'worker.config.json'), JSON.stringify({
  name: 'codex-remote-downloads',
  compatibilityDate: '2026-11-01',
  manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} },
  workersDev: false,
  observability: { enabled: true, redactQueryString: true,
    logs: { enabled: true, headSamplingRate: 0.01 }, traces: { enabled: true, headSamplingRate: 0.01 } },
  triggers: [{ type: 'fetch', pattern: `${hostname}/*`, zone }]
}), 'utf8');
console.log('Download Worker prepared under distribution/.cloudflare/output. No private application routes are published.');
