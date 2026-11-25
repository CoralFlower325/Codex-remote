import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

function realCodexCandidates() {
  const candidates = [];
  if (process.env.CODEX_REMOTE_REAL_CODEX?.trim()) candidates.push(process.env.CODEX_REMOTE_REAL_CODEX.trim());
  if (process.env.CODEX_BINARY?.trim()) candidates.push(process.env.CODEX_BINARY.trim());
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      for (const directory of requireDirectoryEntries(bin)
        .filter(entry => entry.isDirectory())
        .sort((left, right) => right.mtime - left.mtime)) {
        candidates.push(path.join(directory.path, 'codex.exe'));
      }
    } catch { /* The stable candidate below is checked separately. */ }
    candidates.push(path.join(bin, 'codex.exe'));
  }
  candidates.push('codex.exe');
  return [...new Set(candidates)];
}

function requireDirectoryEntries(directory) {
  return fsSync.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const fullPath = path.join(directory, entry.name);
    let mtime = 0;
    try { mtime = fsSync.statSync(fullPath).mtimeMs; } catch { /* Sort it last. */ }
    return { ...entry, path: fullPath, mtime };
  });
}

function existingCodex() {
  for (const candidate of realCodexCandidates()) {
    if (candidate === 'codex.exe' || path.isAbsolute(candidate) && fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

class StdioRpc {
  constructor(child, logPath) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.stderr = '';
    child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    child.on('exit', code => {
      let adapterLog = '';
      try { adapterLog = fsSync.readFileSync(logPath, 'utf8').trim(); } catch { /* Log may not exist. */ }
      for (const pending of this.pending.values()) {
        pending.reject(new Error(
          `Desktop shim exited with ${code}.${this.stderr ? `\n${this.stderr.trim()}` : ''}` +
          `${adapterLog ? `\n${adapterLog}` : ''}`));
      }
      this.pending.clear();
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'App Server request failed.'));
        else pending.resolve(message.result);
        return;
      }
      if (typeof message.method === 'string') {
        this.events.push(message);
        for (const waiter of [...this.eventWaiters]) {
          if (waiter.method === message.method) {
            this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    });
  }

  request(method, params, timeout = 10_000) {
    const id = `acceptance:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `Timed out waiting for ${method}.${this.stderr ? `\n${this.stderr.trim()}` : ''}`));
      }, timeout);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  waitForEvent(method, timeout = 3_000) {
    const existing = this.events.find(event => event.method === method);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      this.eventWaiters.push(waiter);
      setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeout).unref();
    });
  }
}

function closeChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve();
      return;
    }
    child.once('exit', () => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve();
    });
    child.stdin.end();
    setTimeout(() => child.kill(), 2_000).unref();
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ skipped: true, reason: 'The Desktop CLI adapter is Windows-only.' }));
    return;
  }
  const codex = existingCodex();
  if (!codex) throw new Error('Codex CLI was not found.');
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-desktop-shim-'));
  const shimDirectory = path.join(root, 'shim');
  const codexHome = path.join(root, 'codex-home');
  const endpointFile = path.join(shimDirectory, 'app-server.json');
  const log = path.join(root, 'desktop-cli-shim.log');
  const children = [];
  try {
    await fs.mkdir(shimDirectory, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    await fs.copyFile('dist/desktop-shim/codex-remote-cli.exe',
      path.join(shimDirectory, 'codex-remote-cli.exe'));
    await fs.copyFile('dist/desktop-shim/desktop-cli-proxy.mjs',
      path.join(shimDirectory, 'desktop-cli-proxy.mjs'));
    await fs.writeFile(path.join(shimDirectory, 'codex-remote-shim.ini'), [
      `node=${process.execPath}`,
      `proxy=${path.join(shimDirectory, 'desktop-cli-proxy.mjs')}`,
      `realCodex=${codex}`,
      `endpointFile=${endpointFile}`,
      `log=${log}`
    ].join('\n') + '\n', 'utf8');

    const launch = () => {
      const child = spawn(path.join(shimDirectory, 'codex-remote-cli.exe'),
        ['app-server', '--listen', 'stdio://'], {
          cwd: shimDirectory,
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
      children.push(child);
      return new StdioRpc(child, log);
    };

    const first = launch();
    const firstInitialization = await first.request('initialize', {
      clientInfo: { name: 'shim_acceptance_primary', title: 'Shim acceptance', version: '0.3.0' },
      capabilities: { experimentalApi: true }
    });
    first.notify('initialized');
    const firstList = await first.request('thread/list', { limit: 1 });
    const endpoint = JSON.parse(await fs.readFile(endpointFile, 'utf8'));
    if (endpoint.version !== 1 || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url)) {
      throw new Error('The shim did not publish an authenticated loopback endpoint.');
    }
    const unauthorized = await new Promise(resolve => {
      const socket = new WebSocket(endpoint.url);
      const timer = setTimeout(() => {
        socket.terminate();
        resolve('timeout');
      }, 3_000);
      socket.once('open', () => {
        clearTimeout(timer);
        socket.terminate();
        resolve('unexpectedly accepted');
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        resolve(String(response.statusCode));
      });
      socket.once('error', error => {
        clearTimeout(timer);
        resolve(error.message);
      });
      socket.once('close', () => {
        clearTimeout(timer);
        resolve('closed without opening');
      });
    });
    if (!String(unauthorized).includes('401')) {
      throw new Error('The shared App Server accepted a connection without its capability token.');
    }
    const second = launch();
    const secondInitialization = await second.request('initialize', {
      clientInfo: { name: 'shim_acceptance_secondary', title: 'Shim acceptance', version: '0.3.0' },
      capabilities: { experimentalApi: true }
    });
    second.notify('initialized');
    const secondList = await second.request('thread/list', { limit: 1 });

    const started = await first.request('thread/start', {
      cwd: root,
      ephemeral: true
    });
    const broadcast = await second.waitForEvent('thread/started');
    if (!started?.thread?.id || broadcast?.params?.thread?.id !== started.thread.id) {
      throw new Error('Shared App Server did not broadcast the new thread to both clients.');
    }
    const adapterLog = await fs.readFile(log, 'utf8');
    if (!adapterLog.includes('reusing shared App Server endpoint')) {
      throw new Error('The second Desktop client did not reuse the shared App Server.');
    }
    console.log(JSON.stringify({
      ok: true,
      endpoint: 'loopback-websocket',
      capabilityTokenRequired: true,
      clients: 2,
      firstAppServerVersion: firstInitialization?.appServerVersion ?? null,
      secondAppServerVersion: secondInitialization?.appServerVersion ?? null,
      firstThreadCount: Array.isArray(firstList?.data) ? firstList.data.length : null,
      secondThreadCount: Array.isArray(secondList?.data) ? secondList.data.length : null,
      broadcast: true,
      sharedInstanceReused: true
    }));
  } finally {
    for (const child of children.reverse()) await closeChild(child);
    if (process.env.CODEX_REMOTE_KEEP_ACCEPTANCE === '1') {
      console.error(`Acceptance fixture retained at ${root}`);
    } else {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
