import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { latestRelease } from '../desktop/release.mjs';
import { installation } from '../desktop/controller.mjs';
import { pendingUpdate } from '../desktop/update-transaction.mjs';
import { updateError } from '../desktop/update-progress.mjs';
import { requireService, launchWorker } from './web-update-service.mjs';
import { ensureDirectory, updateDirectory, readState, writeState, publicState, alive, validId } from './web-update-state.mjs';
import { fetchRelease } from './web-update-network.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = ['web-update-worker.mjs', 'web-update-state.mjs', 'web-update-service.mjs',
  'web-update-service-windows.ps1', 'web-update-service-macos.sh', 'web-update-launch-windows.ps1',
  'web-update-network.mjs'];
const libraries = ['updater.mjs', 'update-prepare.mjs', 'update-inputs.mjs', 'update-transaction.mjs',
  'update-progress.mjs', 'runtime-package.mjs', 'controller.mjs', 'process.mjs', 'release.mjs'];

async function copyDependencies(root, job) {
  const copied = new Map();
  async function copy(name, from) {
    const require = createRequire(path.join(from, 'package.json'));
    let directory = path.dirname(require.resolve(name));
    let pkg;
    for (;;) {
      try { pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); } catch {}
      if (pkg?.name === name) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('更新器依赖不完整。');
      directory = parent;
    }
    if (copied.has(name)) {
      if (copied.get(name) !== pkg.version) throw new Error('更新器依赖版本冲突。');
      return;
    }
    copied.set(name, pkg.version);
    await fs.cp(directory, path.join(job, 'node_modules', name), { recursive: true, dereference: true });
    for (const dependency of Object.keys(pkg.dependencies || {})) await copy(dependency, directory);
  }
  await copy('tar', root);
  await copy('undici', root);
}

export function createWebUpdater(root, { pid = process.pid, platform = process.platform,
  arch = process.arch, fetcher = fetchRelease, launch = launchWorker, owned = requireService } = {}) {
  let checking = null;
  let offer = null;
  let starting = false;
  const supported = () => ['win32-x64', 'darwin-arm64'].includes(`${platform}-${arch}`);
  async function status() {
    const info = await installation(root);
    return { currentVersion: info.version, platform, arch, supported: supported(),
      operation: publicState(await readState(info.root)) };
  }
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      const info = await installation(root);
      if (!supported()) return { ...await status(), available: false, reason: '支持 Windows x64 和 Apple Silicon。' };
      const pending = await pendingUpdate(info.root);
      let release;
      try { release = pending ? { version: pending.to, tag: `v${pending.to}`, available: false }
        : await latestRelease(info.version, fetcher); }
      catch (error) { throw new Error(`检查 Remote 更新失败。${updateError(error)}`, { cause: error }); }
      let reason = '';
      try { await owned(info.root, pid); }
      catch { reason = '当前后端未由此安装的系统服务管理，请先在本机管理器开启 Remote。'; }
      const recover = Boolean(pending);
      offer = { token: crypto.randomUUID(), release, checkedAt: Date.now(), recover };
      return { ...await status(), available: release.available, latestVersion: release.version,
        canUpdate: !reason, reason, token: offer.token, recoveryRequired: recover };
    })().finally(() => { checking = null; });
    return checking;
  }
  async function start({ token, version, id, recover = false }) {
    if (!validId(id)) throw new Error('更新任务无效。');
    const info = await installation(root);
    const previous = await readState(info.root);
    // A response lost during launch must be discoverable; never launch twice.
    if (previous?.id === id) return publicState(previous);
    if (starting || previous?.status === 'running' && (alive(previous.pid) || Date.now() - previous.updatedAt < 30_000)) {
      throw new Error('已有 Remote 更新任务，请等待完成。');
    }
    if (!supported() || !offer || offer.token !== token || offer.release.version !== version ||
      Date.now() - offer.checkedAt > 10 * 60_000 || (!recover && !offer.release.available) ||
      Boolean(recover) !== offer.recover) throw new Error('版本检查已失效，请重新检查 Remote 更新。');
    starting = true;
    let job;
    try {
      await owned(info.root, pid);
      // Re-fetch only official stable metadata; the request cannot supply files, commands or URLs.
      const release = recover ? offer.release : await latestRelease(info.version, fetcher);
      if (!recover && (release.version !== version || !release.available)) throw new Error('最新版本已变化，请重新检查。');
      await ensureDirectory(info.root);
      job = path.join(updateDirectory(info.root), id);
      await fs.mkdir(job, { mode: 0o700 });
      for (const [folder, names] of [['scripts', scripts], ['desktop', libraries]]) {
        await fs.mkdir(path.join(job, folder));
        for (const name of names) await fs.copyFile(path.join(here, '..', folder, name), path.join(job, folder, name));
      }
      await copyDependencies(info.root, job);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(?:PATH|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/i.test(key)));
      const request = { id, root: info.root, version, fromVersion: info.version, backendPid: pid,
        node: process.execPath, release, recover, env };
      await fs.writeFile(path.join(job, 'request.json'), JSON.stringify(request), { mode: 0o600 });
      await writeState(info.root, { id, root: info.root, version, fromVersion: info.version,
        status: 'running', pid: null, updatedAt: Date.now(), progress: null });
      await launch(job);
      offer = null;
      return publicState(await readState(info.root));
    } catch (error) {
      if (job) {
        const state = await readState(info.root);
        if (state?.id === id && !state.pid) await writeState(info.root, { ...state, status: 'failed',
          updatedAt: Date.now(), message: '独立更新任务未能启动，原服务未更改。' });
      }
      throw error;
    } finally { starting = false; }
  }
  return { status, check, start };
}
