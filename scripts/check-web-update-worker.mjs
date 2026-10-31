import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createWebUpdater } from './web-update.mjs';
import { launchWorker } from './web-update-service.mjs';
import { readState } from './web-update-state.mjs';

if (process.platform !== 'win32') throw new Error('This acceptance exercises the Windows independent process launcher.');
const directory = path.resolve('output/web-update-worker-026');
await fs.mkdir(directory, { recursive: true });
const results = [];
for (const rollback of [false, true]) {
  const root = await fs.mkdtemp(path.join(directory, rollback ? 'rollback-' : 'install-'));
  const stage = await fs.mkdtemp(path.join(directory, 'payload-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const write = async (base, relative, value) => {
    await fs.mkdir(path.dirname(path.join(base, relative)), { recursive: true });
    await fs.writeFile(path.join(base, relative), value, 'utf8');
  };
  const backendSource = version => `import http from 'node:http';http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({ok:true,passwordConfigured:true,codex:'ready',transport:'desktop',version:'${version}'}))}).listen(Number(process.argv[2]),'127.0.0.1');`;
  const oldPackage = JSON.stringify({ name: 'codex-remote', version: '0.2.5', type: 'module' });
  await write(root, 'package.json', oldPackage);
  await write(root, '.env', `PORT=${port}\n`);
  await write(root, 'data/auth.json', 'synthetic-auth-preserved');
  await write(root, 'dist/client/index.html', 'old');
  await write(root, 'dist-server/server/index.js', backendSource('0.2.5'));
  await write(root, 'scripts/remote-control-windows.ps1', '');
  await write(root, 'node_modules/old/sentinel', 'old-dependencies');
  await write(stage, 'package.json', JSON.stringify({ name: 'codex-remote', version: '0.2.6', type: 'module' }));
  await write(stage, 'dist/client/index.html', 'new');
  await write(stage, 'dist-server/server/index.js', backendSource('0.2.6'));
  await write(stage, 'node_modules/new/sentinel', 'new-dependencies');
  const backend = spawn(process.execPath, [path.join(root, 'dist-server/server/index.js'), String(port)], {
    cwd: root, stdio: 'ignore', windowsHide: true
  });
  let newPid;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const fetcher = async () => ({ ok: true, json: async () => ({ tag_name: 'v0.2.6', assets: [] }) });
    const updater = createWebUpdater(root, { pid: backend.pid, fetcher, owned: async () => {},
      launch: async job => {
        await fs.copyFile(path.join(job, 'scripts/web-update-worker.mjs'), path.join(job, 'scripts/web-update-worker-core.mjs'));
        await fs.copyFile('scripts/check-web-update-worker-job.mjs', path.join(job, 'scripts/web-update-worker.mjs'));
        const requestPath = path.join(job, 'request.json');
        const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
        Object.assign(request, { fixturePid: backend.pid, fixturePort: port, fixtureStage: stage, fixtureRollback: rollback,
          fixturePlan: [{ relative: 'package.json', remove: false,
            before: crypto.createHash('sha256').update(oldPackage).digest('hex') }] });
        await fs.writeFile(requestPath, JSON.stringify(request));
        return launchWorker(job);
      }
    });
    const offer = await updater.check();
    await updater.start({ id: crypto.randomUUID(), token: offer.token, version: '0.2.6' });
    let state;
    for (let i = 0; i < 300; i++) {
      state = await readState(root);
      if (state?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.status, rollback ? 'recovered' : 'completed', JSON.stringify(state));
    assert.notEqual(state.pid, backend.pid);
    assert.equal(backend.exitCode === null && backend.signalCode === null, false, 'Old backend must have exited.');
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.version, rollback ? '0.2.5' : '0.2.6');
    assert.equal(await fs.readFile(path.join(root, 'data/auth.json'), 'utf8'), 'synthetic-auth-preserved');
    const dependency = rollback ? 'old' : 'new';
    await fs.access(path.join(root, `node_modules/${dependency}/sentinel`));
    newPid = JSON.parse(await fs.readFile(path.join(root, 'new-pid.json'), 'utf8'));
    results.push({ rollback, status: state.status, oldPid: backend.pid, workerPid: state.pid, newPid, health });
    console.log(`PASS ${rollback ? 'rollback' : 'installation'}: ${state.status}`);
  } finally {
    if (!newPid) newPid = JSON.parse(await fs.readFile(path.join(root, 'new-pid.json'), 'utf8').catch(() => 'null'));
    if (newPid) { try { process.kill(newPid); } catch {} }
    if (backend.exitCode === null && backend.signalCode === null) backend.kill();
  }
}
await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
