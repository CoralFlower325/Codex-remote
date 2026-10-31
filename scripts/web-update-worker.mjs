import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installation, probe } from '../desktop/controller.mjs';
import { prepareUpdate, installUpdate } from '../desktop/updater.mjs';
import { recoverPendingUpdate, pendingUpdate } from '../desktop/update-transaction.mjs';
import { createUpdateProgress, updateError } from '../desktop/update-progress.mjs';
import { serviceControls, requireService } from './web-update-service.mjs';
import { writeState, validId } from './web-update-state.mjs';
import { fetchRelease } from './web-update-network.mjs';

export async function runUpdate(request, dependencies = {}) {
  const { prepare = prepareUpdate, install = installUpdate, owned = requireService,
    controls = serviceControls, recover = recoverPendingUpdate } = dependencies;
  if (!validId(request.id)) throw new Error('更新任务无效。');
  const info = await installation(request.root);
  let state = { id: request.id, root: info.root, fromVersion: request.fromVersion,
    version: request.version, status: 'running', pid: process.pid, updatedAt: Date.now(), progress: null };
  let queue = Promise.resolve();
  let writeFailure = null;
  const save = () => {
    const value = structuredClone(state);
    queue = queue.then(() => {
      if (writeFailure) throw writeFailure;
      return writeState(info.root, value);
    }).catch(error => { writeFailure = error; });
    return queue;
  };
  const flush = async () => { await queue; if (writeFailure) throw writeFailure; };
  const progress = (_title, detail) => {
    state = { ...state, updatedAt: Date.now(), progress: detail };
    if (detail.status === 'recovered' || detail.status === 'recovery-failed') state.status = detail.status;
    // A completed install is published only after the durable transaction returns.
    void save();
  };
  await save();
  try {
    await owned(info.root, request.backendPid);
    const health = await probe(`${info.localUrl}/health`);
    const requireDesktop = health.body?.codex === 'ready' && health.body?.transport === 'desktop';
    const actions = controls(info, requireDesktop);
    const durableActions = { ...actions,
      stop: async () => { await flush(); await actions.stop(); },
      start: async () => { await flush(); await actions.start(); }
    };
    if (request.recover) {
      const pending = await pendingUpdate(info.root);
      if (pending) {
        const report = createUpdateProgress(progress);
        await recover(info.root, { ...durableActions, report });
      }
      state = { ...state, status: 'recovered', message: '已恢复旧版，请重新检查更新。', updatedAt: Date.now() };
    } else {
      const prepared = await prepare(info.root, request.release, progress, undefined, { fetcher: fetchRelease });
      await flush();
      await owned(info.root, request.backendPid);
      await install(prepared, { ...durableActions, progress, requireDesktop });
      state = { ...state, status: 'completed', updatedAt: Date.now() };
    }
  } catch (error) {
    if (!['recovered', 'recovery-failed'].includes(state.status)) state.status = 'failed';
    state = { ...state, updatedAt: Date.now(), message: state.status === 'recovered'
      ? '本次更新未完成，已恢复旧版。' : state.status === 'recovery-failed'
        ? '恢复尚未完成，请在本机管理器恢复更新。' : `更新未完成。${updateError(error)}` };
  }
  await save();
  await flush();
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  Object.assign(process.env, request.env);
  try { await runUpdate(request); } finally {
    // The updater owns no resident work. Undici proxy pools must not retain it.
    process.exit(0);
  }
}
