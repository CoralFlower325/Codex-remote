import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runUpdate } from './web-update-worker-core.mjs';
import { createUpdateProgress } from '../desktop/update-progress.mjs';

// Runs only in the disposable acceptance installation, never an OS service.
const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
let backendPid = request.fixturePid;
let failVerify = request.fixtureRollback;
const result = await runUpdate(request, {
  owned: async () => {},
  prepare: async (_root, release, progress) => ({
    info: { root: request.root, version: request.fromVersion, publicUrl: '' },
    release, stage: request.fixtureStage, payload: request.fixtureStage, plan: request.fixturePlan,
    mode: 'runtime', tools: {}, commit: 'synthetic', report: createUpdateProgress(progress)
  }),
  controls: info => ({
    isRunning: async () => Boolean(backendPid),
    stop: async () => {
      if (!backendPid) return;
      try { process.kill(backendPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let i = 0; i < 100; i++) {
        try { process.kill(backendPid, 0); } catch { backendPid = null; return; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Fixture backend did not stop.');
    },
    start: async () => {
      const child = spawn(process.execPath, [path.join(info.root, 'dist-server/server/index.js'), String(request.fixturePort)],
        { cwd: info.root, stdio: 'ignore', windowsHide: true, detached: true });
      child.unref(); backendPid = child.pid;
      await fs.writeFile(path.join(info.root, 'new-pid.json'), JSON.stringify(backendPid));
    },
    verify: async () => {
      if (failVerify) { failVerify = false; throw new Error('Synthetic verification failure'); }
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${request.fixturePort}/health`);
          if (response.ok && (await response.json()).ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Fixture backend not ready.');
    }
  })
});
await fs.writeFile(path.join(request.root, 'acceptance-worker-result.json'), JSON.stringify(result));
process.exit(0);
