import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { x as extract } from 'tar';
import { assertManifestRuntimeNode, runtimeNames, validateManifest, unpackRuntime, sha256 } from '../desktop/runtime-package.mjs';
import { prepareUpdate, installUpdate, compareVersions } from '../desktop/updater.mjs';
import { run } from '../desktop/process.mjs';
import { pendingUpdate } from '../desktop/update-transaction.mjs';
import { verifyRelease } from '../desktop/release-signature.mjs';

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const names = runtimeNames(pkg.version);
// Stable update selection rejects prerelease tags. The package itself remains
// versioned as the RC while acceptance exercises the next numeric release.
const acceptanceTag = `v${pkg.version.split('-', 1)[0]}`;
const manifest = validateManifest(verifyRelease(JSON.parse(await fs.readFile(path.join('output/runtime', names.manifest), 'utf8'))), pkg);
assertManifestRuntimeNode(manifest);
const archive = path.resolve('output/runtime', names.archive);
if (sha256(await fs.readFile(archive)) !== manifest.archive.sha256) throw new Error('Archive checksum mismatch.');
const temporary = await fs.mkdtemp(path.resolve('output/runtime-check-'));
try {
  const payload = path.join(temporary, 'payload');
  await unpackRuntime(archive, payload, manifest);
  execFileSync(process.execPath, ['scripts/check-runtime.mjs'], { cwd: payload, stdio: 'inherit' });
  const latestBaseline = Object.keys(manifest.baselines).sort((a, b) => compareVersions(b, a))[0];
  if (!latestBaseline) throw new Error('No released source baseline available for upgrade acceptance.');
  const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const manifestPath = path.resolve('output/runtime', names.manifest);
  const assets = [[names.manifest, manifestPath], [names.archive, archive]].map(([name, target]) => ({
    name, target, size: name === names.archive ? manifest.archive.size : null,
    browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/${acceptanceTag}/${name}`
  }));
  for (const asset of assets) {
    const bytes = await fs.readFile(asset.target);
    asset.size = bytes.length; asset.digest = `sha256:${sha256(bytes)}`;
  }
  const fetcher = async (url) => {
    const asset = assets.find((item) => url.endsWith(`/${item.name}`));
    if (!asset) throw new Error('Unexpected runtime download.');
    return new Response(Readable.toWeb(createReadStream(asset.target)));
  };
  const baselines = [...new Set([latestBaseline, ...(manifest.baselines['0.2.7'] ? ['0.2.7'] : [])])];
  for (const baseline of baselines) {
    const baseArchive = path.join(temporary, `old-source-${baseline}.tar`);
    execFileSync('git', ['-C', repositoryRoot, 'archive', '--format=tar', `--output=${baseArchive}`, `v${baseline}`]);
    for (const scenario of ['stopped', 'running', 'rollback']) {
      const failVerify = scenario === 'rollback';
      const wasRunning = scenario !== 'stopped';
      const root = path.join(temporary, `${baseline}-${scenario}`);
      await fs.mkdir(root);
      await extract({ file: baseArchive, cwd: root });
      for (const dir of ['dist/client', 'dist-server/server', 'node_modules', 'data']) {
        await fs.mkdir(path.join(root, dir), { recursive: true });
      }
      await fs.writeFile(path.join(root, 'dist/client/index.html'), 'previous public page');
      await fs.writeFile(path.join(root, 'dist-server/server/index.js'), '// previous server fixture');
      await fs.writeFile(path.join(root, 'node_modules/old-dependency'), 'previous dependencies');
      await fs.writeFile(path.join(root, 'data/auth.json'), 'synthetic private fixture');
      await fs.writeFile(path.join(root, '.env'), 'PORT=4545\n');
      await fs.writeFile(path.join(root, 'scripts/.DS_Store'), 'synthetic Finder metadata');
      const prepared = await prepareUpdate(root, { tag: acceptanceTag, version: pkg.version, assets }, () => {},
        (command, args, options) => {
          if (command === 'git' || args.some((arg) => /npm-cli|typecheck|^test$|^build$/.test(arg))) {
            throw new Error('A standard update must not run Git, npm or build tools.');
          }
          return run(command, args, options);
        }, { fetcher });
      if (prepared.mode !== 'runtime') throw new Error('Runtime update path was not selected.');
      let started = 0; let verified = 0;
      try {
        await installUpdate(prepared, { stop: async () => {},
          start: async () => { started++; },
          isRunning: async () => wasRunning,
          verify: async () => {
            if (++verified === 1) {
              execFileSync(process.execPath, ['scripts/check-runtime.mjs'], { cwd: root, stdio: 'inherit' });
              if (failVerify) throw new Error('Injected startup verification failure.');
            }
          } });
        if (failVerify) throw new Error('Expected rollback did not happen.');
      } catch (error) {
        if (!failVerify || !error.message.includes('已恢复旧版')) throw error;
      }
      const installed = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      if (installed.version !== (failVerify ? baseline : pkg.version) || await pendingUpdate(root)) {
        throw new Error('Installed version or completed transaction mismatch.');
      }
      if (failVerify) {
        if (started !== 2 || verified !== 2 ||
          await fs.readFile(path.join(root, 'node_modules/old-dependency'), 'utf8') !== 'previous dependencies') {
          throw new Error('Original dependencies or run state not restored.');
        }
      } else {
        if (started !== (wasRunning ? 1 : 0) || verified !== (wasRunning ? 1 : 0)) {
          throw new Error('Installation run state or verification mismatch.');
        }
        execFileSync(process.execPath, ['scripts/check-runtime.mjs'], { cwd: root, stdio: 'inherit' });
      }
      if (await fs.readFile(path.join(root, 'data/auth.json'), 'utf8') !== 'synthetic private fixture' ||
        await fs.readFile(path.join(root, '.env'), 'utf8') !== 'PORT=4545\n') throw new Error('Private fixture changed.');
      console.log(`Verified ${baseline} -> ${pkg.version}: ${scenario}.`);
    }
  }
  console.log('已验证解压后的运行包。');
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
