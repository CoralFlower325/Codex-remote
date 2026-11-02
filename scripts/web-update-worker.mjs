import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installation, probe } from '../desktop/controller.mjs';
import { prepareUpdate, installUpdate } from '../desktop/updater.mjs';
import { acquireUpdateLock, recoverPendingUpdate, pendingUpdate } from '../desktop/update-transaction.mjs';
import { createUpdateProgress, updateError } from '../desktop/update-progress.mjs';
import { serviceControls, requireService } from './web-update-service.mjs';
import { alive, readState, writeState, validId } from './web-update-state.mjs';
import { fetchRelease } from './web-update-network.mjs';

const stateWriteRetries = 3;
const stateWriteDelay = 50;

const retryStateWrite = async (root, value) => {
  let failure;
  for (let attempt = 0; attempt < stateWriteRetries; attempt++) {
    try {
      await writeState(root, value);
      return;
    } catch (error) {
      failure = error;
      if (attempt + 1 === stateWriteRetries) break;
      await new Promise((resolve) => setTimeout(resolve, stateWriteDelay * (attempt + 1)));
    }
  }
  throw failure;
};

export async function runUpdate(request, dependencies = {}) {
  const { prepare = prepareUpdate, install = installUpdate, owned = requireService,
    controls = serviceControls, recover = recoverPendingUpdate } = dependencies;
  if (!validId(request.id)) throw new Error('更新任务无效。');
  const info = await installation(request.root);
  let previous, state;
  let queue = Promise.resolve();
  let writeFailure = null;
  const save = () => {
    const value = structuredClone(state);
    queue = queue.then(() => {
      return retryStateWrite(info.root, value)
        .then(() => { writeFailure = null; })
        .catch(error => { writeFailure = error; });
    });
    return queue;
  };
  const flush = async () => { await queue; if (writeFailure) throw writeFailure; };
  const progress = (_title, detail) => {
    state = { ...state, updatedAt: Date.now(),
      progress: { ...detail, startedAt: previous?.progress?.startedAt ?? detail.startedAt } };
    // A completed install is published only after the durable transaction returns.
    void save();
  };
  // Serialize worker takeover with a new start. Once claimed, the live worker
  // PID prevents replacement until its final durable outcome is published.
  const unlock = await acquireUpdateLock(info.root);
  try {
    previous = await readState(info.root, request.id);
    const active = await readState(info.root);
    if (active && active.id !== request.id || previous && (previous.status !== 'running' ||
      previous.pid === null && Date.now() - previous.updatedAt > 30_000 ||
      previous.pid !== request.backendPid && alive(previous.pid))) {
      throw new Error('更新任务已结束或已被替代，未改动原服务。');
    }
    state = { id: request.id, root: info.root, fromVersion: request.fromVersion,
      version: request.version, status: 'running', pid: process.pid, updatedAt: Date.now(), progress: previous?.progress ?? null };
    await save();
    await flush();
  } finally { await unlock(); }
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    state = { ...state, updatedAt: Date.now() };
    void save().finally(() => { heartbeatPending = false; });
  }, 5000);
  heartbeat.unref();
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
    state.status = ['recovered', 'recovery-failed'].includes(state.progress?.status) ? state.progress.status : 'failed';
    state = { ...state, updatedAt: Date.now(), message: state.status === 'recovered'
      ? '本次更新未完成，已恢复旧版。' : state.status === 'recovery-failed'
        ? '恢复尚未完成，请在本机管理器恢复更新。' : `更新未完成。${updateError(error)}` };
  } finally { clearInterval(heartbeat); }
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
