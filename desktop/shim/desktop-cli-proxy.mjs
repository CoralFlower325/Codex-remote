import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const ENDPOINT_FILE = path.resolve(process.env.CODEX_REMOTE_APP_SERVER_ENDPOINT_FILE ||
  path.join(process.cwd(), 'data', 'desktop-shim', 'app-server.json'));
const TOKEN_FILE = `${ENDPOINT_FILE}.token`;
const LOCK_FILE = `${ENDPOINT_FILE}.lock`;
const LOG_PATH = process.env.CODEX_REMOTE_SHIM_LOG ||
  path.join(path.dirname(ENDPOINT_FILE), 'desktop-cli-shim.log');
const START_TIMEOUT_MS = clampedTimeout(process.env.CODEX_REMOTE_SHIM_START_TIMEOUT_MS,
  60_000, 5_000, 180_000);

function clampedTimeout(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function appendLog(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* Logging must not break the bridge. */ }
}

function securePath(target, directory) {
  if (process.platform !== 'win32') {
    fs.chmodSync(target, directory ? 0o700 : 0o600);
    return;
  }
  const user = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
  const sid = user.split(',').at(-1)?.replaceAll('"', '').trim();
  if (!sid?.startsWith('S-')) throw new Error('The current Windows user SID is unavailable.');
  const suffix = directory ? ':(OI)(CI)F' : ':F';
  execFileSync('icacls.exe', [
    target,
    '/inheritance:r',
    '/grant:r',
    `*${sid}${suffix}`,
    `*S-1-5-18${suffix}`,
    `*S-1-5-32-544${suffix}`
  ], { windowsHide: true, timeout: 15_000 });
}

function newest(directory, accept) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && accept(entry.name))
      .map(entry => {
        const full = path.join(directory, entry.name);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return { full, mtime: 0 }; }
      })
      .sort((left, right) => right.mtime - left.mtime)
      .map(entry => entry.full);
  } catch {
    return [];
  }
}

function realCodexCandidates() {
  const candidates = [];
  if (process.env.CODEX_REMOTE_REAL_CODEX?.trim()) candidates.push(process.env.CODEX_REMOTE_REAL_CODEX.trim());
  if (process.env.CODEX_BINARY?.trim()) candidates.push(process.env.CODEX_BINARY.trim());
  const programFiles = process.env.ProgramFiles?.trim();
  if (programFiles) {
    const packages = path.join(programFiles, 'WindowsApps');
    for (const directory of newest(packages, name => name.startsWith('OpenAI.Codex_'))) {
      candidates.push(path.join(directory, 'app', 'resources', 'codex.exe'));
    }
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    for (const directory of newest(bin, () => true)) candidates.push(path.join(directory, 'codex.exe'));
    candidates.push(path.join(bin, 'codex.exe'));
  }
  candidates.push('codex.exe', 'codex');
  return [...new Set(candidates)];
}

function findRealCodex() {
  return realCodexCandidates().find(candidate =>
    candidate === 'codex.exe' || candidate === 'codex' || fs.existsSync(candidate));
}

function realCodexEnvironment() {
  const environment = { ...process.env };
  delete environment.CODEX_CLI_PATH;
  return environment;
}

function appServerArgs(args) {
  const appServerIndex = args.indexOf('app-server');
  if (appServerIndex < 0) return null;
  const subcommand = args[appServerIndex + 1];
  if (subcommand && !subcommand.startsWith('-')) return null;
  const next = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--listen' || value.startsWith('--listen=')) {
      if (value === '--listen') index++;
      continue;
    }
    if (['--ws-auth', '--ws-token-file', '--ws-token-sha256'].includes(value)) {
      index++;
      continue;
    }
    if (value.startsWith('--ws-auth=') || value.startsWith('--ws-token-file=') ||
        value.startsWith('--ws-token-sha256=')) continue;
    next.push(value);
    if (index === appServerIndex) {
      next.push(
        '--listen', 'ws://127.0.0.1:0',
        '--ws-auth', 'capability-token',
        '--ws-token-file', TOKEN_FILE
      );
    }
  }
  return next;
}

function validLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === '/' || url.pathname === '');
  } catch {
    return false;
  }
}

async function readEndpoint() {
  try {
    const value = JSON.parse(await fsp.readFile(ENDPOINT_FILE, 'utf8'));
    if (value?.version !== 1 || !validLoopbackUrl(value?.url)) return null;
    const token = (await fsp.readFile(TOKEN_FILE, 'utf8')).trim();
    if (token.length < 32 || token.length > 4096 || /[\r\n]/.test(token)) return null;
    return { url: value.url, token, pid: Number(value.pid) || null, startedAt: Number(value.startedAt) || null };
  } catch {
    return null;
  }
}

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      maxPayload: 128 * 1024 * 1024,
      perMessageDeflate: false
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('timeout'));
    }, 1_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function existingServer() {
  const endpoint = await readEndpoint();
  if (!endpoint) return null;
  try {
    return { socket: await connect(endpoint), endpoint, child: null };
  } catch {
    return null;
  }
}

async function lockOwnerAlive() {
  try {
    const lock = JSON.parse(await fsp.readFile(LOCK_FILE, 'utf8'));
    const pid = Number(lock.pid);
    if (!Number.isInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return Date.now() - Number(lock.createdAt || 0) < START_TIMEOUT_MS + 30_000;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(LOCK_FILE, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await lockOwnerAlive()) return false;
      try { await fsp.unlink(LOCK_FILE); } catch { /* Another process may have removed it. */ }
    }
  }
  return false;
}

async function releaseLock() {
  try {
    const lock = JSON.parse(await fsp.readFile(LOCK_FILE, 'utf8'));
    if (Number(lock.pid) === process.pid) await fsp.unlink(LOCK_FILE);
  } catch { /* A missing or replaced lock is not ours. */ }
}

async function waitForEndpoint(child) {
  return new Promise((resolve, reject) => {
    let pending = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Codex App Server did not report a listening endpoint.')),
      START_TIMEOUT_MS);
    const finish = (error, endpoint) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(endpoint);
    };
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      appendLog(text.trimEnd());
      pending = `${pending}${text}`.slice(-16_384);
      const match = pending.match(/listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(null, match[1]);
    });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`Codex App Server exited with ${code}.`)));
  });
}

async function writeEndpoint(url, pid) {
  const endpoint = {
    version: 1,
    url,
    pid,
    startedAt: Date.now()
  };
  const temporary = `${ENDPOINT_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, ENDPOINT_FILE);
}

async function startServer() {
  const codex = findRealCodex();
  if (!codex) throw new Error('Codex CLI was not found.');
  await fsp.mkdir(path.dirname(ENDPOINT_FILE), { recursive: true, mode: 0o700 });
  securePath(path.dirname(ENDPOINT_FILE), true);
  await fsp.writeFile(TOKEN_FILE, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
  securePath(TOKEN_FILE, false);
  await fsp.rm(ENDPOINT_FILE, { force: true });
  appendLog(`starting ${codex} app-server (authenticated loopback)`);
  const child = spawn(codex, appServerArgs(process.argv.slice(2)), {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: realCodexEnvironment()
  });
  try {
    const url = await waitForEndpoint(child);
    await writeEndpoint(url, child.pid);
    const endpoint = await readEndpoint();
    if (!endpoint) throw new Error('Codex App Server endpoint file could not be read.');
    return { socket: await connect(endpoint), endpoint, child };
  } catch (error) {
    try { child.kill(); } catch { /* Already stopped. */ }
    throw error;
  }
}

async function sharedServer() {
  const existing = await existingServer();
  if (existing) {
    appendLog('reusing shared App Server endpoint');
    return existing;
  }
  if (!(await acquireLock())) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const endpoint = await existingServer();
      if (endpoint) {
        appendLog('joined shared App Server started by another client');
        return endpoint;
      }
    }
    throw new Error('Timed out waiting for another client to start the App Server.');
  }
  try {
    const secondCheck = await existingServer();
    if (secondCheck) {
      appendLog('reusing shared App Server endpoint');
      return secondCheck;
    }
    return await startServer();
  } finally {
    await releaseLock();
  }
}

async function runPassthrough(args) {
  const codex = findRealCodex();
  if (!codex) throw new Error('Codex CLI was not found.');
  const child = spawn(codex, args, {
    stdio: 'inherit', windowsHide: true, env: realCodexEnvironment()
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  process.exitCode = typeof code === 'number' ? code : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (!appServerArgs(args)) {
    await runPassthrough(args);
    return;
  }

  const { socket, child, endpoint } = await sharedServer();
  let stdinClosed = false;
  const queued = [];
  const stdoutQueue = [];
  let stdoutBlocked = false;
  const flushStdout = () => {
    while (stdoutQueue.length) {
      if (!process.stdout.write(stdoutQueue.shift())) return;
    }
    stdoutBlocked = false;
    socket.resume();
  };
  process.stdout.on('drain', flushStdout);
  socket.on('message', data => {
    appendLog(`forwarding App Server message (${data.length} bytes)`);
    const line = `${data.toString()}\n`;
    if (stdoutBlocked || !process.stdout.write(line)) {
      stdoutBlocked = true;
      stdoutQueue.push(line);
      socket.pause();
    }
  });
  socket.on('close', () => {
    if (!stdinClosed) process.exitCode = 1;
    if (child) child.kill();
  });
  socket.on('error', error => appendLog(`WebSocket error: ${error.message}`));

  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on('line', line => {
    appendLog(`forwarding Desktop request (${Buffer.byteLength(line)} bytes)`);
    if (socket.readyState === WebSocket.OPEN) socket.send(line);
    else if (socket.readyState === WebSocket.CONNECTING) queued.push(line);
  });
  reader.on('close', () => {
    stdinClosed = true;
    for (const line of queued.splice(0)) socket.send(line);
    socket.close();
    if (child) child.kill();
  });
  if (socket.readyState === WebSocket.OPEN) {
    for (const line of queued.splice(0)) socket.send(line);
  }
  if (child) {
    child.once('exit', async () => {
      try {
        const current = await readEndpoint();
        if (current?.pid === child.pid || current?.url === endpoint.url) {
          await fsp.rm(ENDPOINT_FILE, { force: true });
        }
      } catch { /* Cleanup is best effort. */ }
    });
  }
}

main().catch(error => {
  appendLog(`fatal: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  console.error(`Codex Remote CLI shim: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
