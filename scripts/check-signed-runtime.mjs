import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runtimeFile } from './runtime-files.mjs';
import { runtimePath, runtimeNames, sha256, validateManifest, unpackRuntime } from '../desktop/runtime-package.mjs';

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalDirectory = process.cwd();
const previousKey = process.env.RELEASE_SIGNING_KEY;
const temporaryParent = await fs.realpath(os.tmpdir());
const temporary = await fs.mkdtemp(path.join(temporaryParent, 'codex-signed-runtime-'));
const fixture = path.join(temporary, 'fixture');
const output = path.join(temporary, 'output');
const receiptPath = path.join(repository, 'output', 'acceptance', 'signed-runtime.json');
const run = (file, args, cwd = fixture) => execute(file, args, {
  cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
});
const gitBefore = await run('git', ['status', '--porcelain=v1', '-z'], repository);
const headBefore = await run('git', ['rev-parse', 'HEAD'], repository);
let receipt;
try {
  await fs.mkdir(fixture);
  await fs.mkdir(output);
  const { stdout } = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], repository);
  const sources = [...new Set(stdout.split('\0').filter(Boolean))]
    .filter(name => !/^(?:data|output|node_modules|dist|dist-server|\.git)(?:\/|$)|^\.env/i.test(name));
  for (const name of sources) {
    runtimePath(name);
    const source = path.join(repository, name);
    const stat = await fs.lstat(source).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe fixture source: ${name}`);
    await fs.mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
    await fs.copyFile(source, path.join(fixture, name));
  }
  for (const name of ['dist', 'dist-server', 'node_modules']) {
    await fs.cp(path.join(repository, name), path.join(fixture, name), {
      recursive: true, dereference: false,
      filter: source => runtimeFile(path.relative(repository, source))
    });
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = sha256(Buffer.from(publicPem));
  await fs.writeFile(path.join(fixture, 'desktop/release-keys.mjs'),
    `export const trustedReleaseKeys = ${JSON.stringify({ [keyId]: publicPem })};\n`, 'utf8');
  await run('git', ['init']);
  await run('git', ['config', 'user.name', 'Synthetic Runtime Acceptance']);
  await run('git', ['config', 'user.email', 'runtime-fixture@example.invalid']);
  await run('git', ['config', 'core.autocrlf', 'true']);
  await run('git', ['config', 'commit.gpgSign', 'false']);
  await run('git', ['config', 'core.hooksPath', path.join(fixture, '.git', 'no-hooks')]);
  await run('git', ['add', '--all']);
  await run('git', ['commit', '--quiet', '-m', 'Synthetic signed runtime fixture']);
  process.chdir(fixture);
  process.env.RELEASE_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const { packageRuntime } = await import(pathToFileURL(path.join(fixture, 'scripts/package-runtime.mjs')).href);
  const { verifyRelease } = await import(pathToFileURL(path.join(fixture, 'desktop/release-signature.mjs')).href);
  const manifest = await packageRuntime(fixture, output);
  const version = JSON.parse(await fs.readFile(path.join(fixture, 'package.json'), 'utf8')).version;
  const names = runtimeNames(version);
  const saved = JSON.parse(await fs.readFile(path.join(output, names.manifest), 'utf8'));
  validateManifest(verifyRelease(saved), { version });
  if (saved.signature.keyId !== keyId || saved.commit !== manifest.commit) throw new Error('Synthetic signer mismatch.');
  let rejected = false;
  try { verifyRelease({ ...saved, commit: 'f'.repeat(40) }); } catch { rejected = true; }
  if (!rejected) throw new Error('A modified signed manifest was accepted.');
  const archive = path.join(output, names.archive);
  const bytes = await fs.readFile(archive);
  if (bytes.length !== saved.archive.size || sha256(bytes) !== saved.archive.sha256) throw new Error('Archive digest mismatch.');
  const payload = path.join(temporary, 'payload');
  await unpackRuntime(archive, payload, saved);
  for (const name of ['scripts/background-service.mjs', 'scripts/rotating-log.mjs',
    'dist-server/server/terminal-worker.js', 'desktop/release-signature.mjs', 'desktop/release-keys.mjs']) {
    if (!saved.files[name]) throw new Error(`Signed archive omitted ${name}`);
    await fs.access(path.join(payload, name));
  }
  const checked = await run(process.execPath, ['scripts/check-runtime.mjs'], payload);
  if (!checked.stdout.includes('\u901a\u8fc7')) throw new Error('Unpacked runtime acceptance did not complete.');
  receipt = { passed: true, checkedAt: new Date().toISOString(), version, platform: process.platform, arch: process.arch,
    files: Object.keys(saved.files).length, archiveBytes: saved.archive.size, archiveSha256: saved.archive.sha256,
    signer: 'ephemeral-fixture-ed25519', manifestSignatureVerified: true, modifiedManifestRejected: rejected,
    unpackedFilesVerified: true, compiledPtyWorkerVerified: true, serviceWrapperIncluded: true,
    productionKeyUsed: false, serviceInstalled: false, fixtureOnlyCommit: true };
  console.log(`Synthetic signed runtime passed: ${version}, ${Object.keys(saved.files).length} files; isolated compiled PTY and wrapper present.`);
} finally {
  process.chdir(originalDirectory);
  if (previousKey === undefined) delete process.env.RELEASE_SIGNING_KEY;
  else process.env.RELEASE_SIGNING_KEY = previousKey;
  const resolved = await fs.realpath(temporary);
  if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('codex-signed-runtime-')) {
    throw new Error('Refusing cleanup outside the verified temporary fixture.');
  }
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const gitAfter = await run('git', ['status', '--porcelain=v1', '-z'], repository);
  const headAfter = await run('git', ['rev-parse', 'HEAD'], repository);
  if (gitBefore.stdout !== gitAfter.stdout || headBefore.stdout !== headAfter.stdout) {
    throw new Error('Repository Git state changed during isolated acceptance.');
  }
  if (receipt) {
    Object.assign(receipt, { fixtureCleaned: true, repositoryGitStateUnchanged: true, repositoryHead: headAfter.stdout.trim() });
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(`Receipt: ${receiptPath}`);
  }
}
