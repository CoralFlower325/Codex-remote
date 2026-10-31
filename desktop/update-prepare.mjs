import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from './process.mjs';
import { installation, commandEnvironment } from './controller.mjs';
import { createUpdateProgress, updateError } from './update-progress.mjs';
import { runtimeNames, validateManifest, downloadAsset, unpackRuntime, sourceHash } from './runtime-package.mjs';
import { pendingUpdate } from './update-transaction.mjs';
import { compareVersions, versionPattern } from './release.mjs';
import { regularFile, planFiles, hash, buildFileNames, runtimeNode, nodeToolchain,
  withNetworkRetry, removePreparation, mergeBuildInputs, installDependencies, npmCommand } from './update-inputs.mjs';

const repository = 'https://github.com/CoralFlower325/Codex-remote.git';

// Preparation is side-effect free for the live installation: fetch, compare and
// build in an isolated directory before any service is stopped.
export async function prepareUpdate(directory, release, progress, execute = run, options = {}) {
  const info = await installation(directory);
  if (await pendingUpdate(info.root)) throw new Error('检测到未完成更新，请先恢复旧版。');
  if (!versionPattern.test(release.tag) || compareVersions(release.tag, info.version) <= 0) {
    throw new Error('没有可安装的新版本，请重新检查版本。');
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-update-'));
  const report = createUpdateProgress(progress);
  let cache;
  try {
    const names = runtimeNames(release.version);
    const manifestAsset = release.assets?.find((asset) => asset.name === names.manifest);
    const archiveAsset = release.assets?.find((asset) => asset.name === names.archive);
    if (manifestAsset || archiveAsset) {
      if (!manifestAsset || !archiveAsset) throw new Error('当前平台的运行包尚未发布完整，请稍后重新检查更新。');
      report.start('fetch');
      if (manifestAsset.size > 8 * 1024 * 1024) throw new Error('运行包清单过大。');
      const manifestFile = path.join(stage, 'manifest.json');
      await withNetworkRetry(async () => {
        await fs.rm(manifestFile, { force: true });
        await downloadAsset(manifestAsset, manifestFile, options);
      }, report);
      const manifest = validateManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')), release);
      report.finish('fetch');
      report.start('compare');
      const baseline = manifest.baselines[info.version];
      if (baseline) {
        const plan = [];
        const inputs = [];
        let custom = false;
        const names = new Set([...Object.keys(baseline), ...Object.keys(manifest.sources)]);
        for (const relative of names) {
          const local = await regularFile(info.root, relative);
          const localHash = local ? sourceHash(local) : null;
          const before = baseline[relative] || null;
          const after = manifest.sources[relative] || null;
          inputs.push({ relative, before: hash(local) });
          if (localHash !== before && /^(?:src\/|public\/|scripts\/|package(?:-lock)?\.json$|tsconfig|vite)/.test(relative)) {
            custom = true;
          }
          if (before === after || localHash === after) continue;
          const preserve = localHash !== before;
          if (preserve && !/^(?:AGENTS\.md|CLAUDE\.md|README(?:\.[\w-]+)?\.md|docs\/.+\.md)$/.test(relative)) {
            custom = true;
          }
          plan.push({ relative, remove: !after, before: hash(local), ...(preserve ? { preserve: true } : {}) });
        }
        // An untracked local build input must also retain its behavior.
        const runtimeFiles = await buildFileNames(info.root);
        if (runtimeFiles.some((name) => !names.has(name))) custom = true;
        if (!custom) {
          const tools = await runtimeNode(execute);
          report.finish('compare');
          report.start('runtime');
          const archive = path.join(stage, 'runtime.tar.gz');
          if (archiveAsset.size !== manifest.archive.size || archiveAsset.digest !== `sha256:${manifest.archive.sha256}`) {
            throw new Error('Release 与运行包清单的校验值不一致。');
          }
          await withNetworkRetry(async () => {
            await fs.rm(archive, { force: true });
            await downloadAsset(archiveAsset, archive, { ...options,
              progress: (loaded, total) => report.download(loaded, total) });
          }, report);
          report.finish('runtime');
          report.start('unpack');
          const payload = path.join(stage, 'payload');
          await unpackRuntime(archive, payload, manifest);
          const pkg = JSON.parse(await fs.readFile(path.join(payload, 'package.json'), 'utf8'));
          if (pkg.name !== 'codex-remote' || pkg.version !== release.version) throw new Error('Release version mismatch.');
          await execute(tools.node, ['scripts/check-runtime.mjs'], { cwd: payload, env: tools.env, timeout: 30_000, onLine: report.output });
          report.finish('unpack');
          return { info, stage, payload, plan, inputs, runtimeFiles, tools, commit: manifest.commit, release, execute, report, mode: 'runtime' };
        }
        report.note('检测到本机源码定制，将使用隔离源码构建以保留现有行为。');
      } else report.note('此安装版本不在运行包基线中，将使用兼容的源码更新。');
    }
    report.start('fetch');
    const git = (args) => execute('git', ['-C', stage, ...args], { env: commandEnvironment(), timeout: 180_000 });
    await git(['init']);
    await git(['remote', 'add', 'origin', repository]);
    await withNetworkRetry(() => execute('git', ['-C', stage, 'fetch', '--depth=1', 'origin',
      `refs/tags/${release.tag}:refs/tags/${release.tag}`,
      `refs/tags/v${info.version}:refs/tags/v${info.version}`],
    { env: commandEnvironment(), timeout: 180_000, onLine: report.output }), report);
    await git(['checkout', '--detach', release.tag]);
    const commit = await git(['rev-parse', 'HEAD']);
    const pkg = JSON.parse(await fs.readFile(path.join(stage, 'package.json'), 'utf8'));
    if (pkg.name !== 'codex-remote' || pkg.version !== release.version) throw new Error('Release version mismatch.');
    report.finish('fetch');
    report.start('compare');
    const files = (await git(['diff', '--name-only', '--no-renames', `v${info.version}`, release.tag])).split('\n').filter(Boolean);
    // Read only public source files. Runtime data never enters the update plan.
    const readBase = async (file) => {
      const exists = await git(['ls-tree', '--name-only', `v${info.version}`, '--', file]);
      if (!exists) return null;
      return Buffer.from(await execute('git', ['-C', stage, 'show', `v${info.version}:${file}`],
        { env: commandEnvironment(), timeout: 30_000, raw: true }));
    };
    // Binary-safe git blobs are read separately, with no trimming or transcoding.
    const plan = await planFiles(info.root, stage, files, readBase);
    const retained = plan.filter((item) => item.preserve);
    if (retained.length) report.note(`将保留 ${retained.length} 份本机文档，并保存新版副本供对照。`);
    for (const item of plan) item.before = hash(await regularFile(info.root, item.relative));
    const inputs = await mergeBuildInputs(info.root, stage, plan);
    const tools = await nodeToolchain(execute);
    cache = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-npm-'));
    // CLI configuration wins over project/user npmrc. The environment also
    // carries the same cache into lifecycle scripts and nested npm commands.
    for (const key of Object.keys(tools.env)) {
      if (key.toLowerCase() === 'npm_config_cache') delete tools.env[key];
    }
    tools.cache = cache;
    tools.env.npm_config_cache = cache;
    tools.env.npm_config_update_notifier = 'false';
    report.finish('compare');
    report.start('dependencies');
    await installDependencies(tools, stage, execute, report);
    report.finish('dependencies');
    for (const [key, args] of [['typecheck', ['run', 'typecheck']], ['test', ['test']], ['build', ['run', 'build']]]) {
      report.start(key);
      await execute(...npmCommand(tools, args, stage, report.output));
      report.finish(key);
    }
    report.start('offline');
    await installDependencies(tools, stage, execute, report, true);
    report.finish('offline');
    return { info, stage, plan, inputs, tools, commit, release, execute, report, mode: 'source' };
  } catch (error) {
    const cleaned = await removePreparation(stage, cache);
    const message = `${updateError(error)}\n尚未安装新版本，原有服务和文件保持原状。`;
    report.terminal('failed', '更新准备未完成',
      message + (cleaned ? '' : '\n部分临时文件未能清理，可稍后重试。'), error);
    throw new Error(message, { cause: error });
  }
}

