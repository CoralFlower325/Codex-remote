import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWindowsTerminalJob } from './terminal-job.js';

const windowsOnly = process.platform === 'win32' ? it : it.skip;
const helper = fileURLToPath(new URL('../../scripts/terminal-job-windows.ps1', import.meta.url));

async function waitFor(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for terminal job test condition.');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('Windows terminal Job Object helper', () => {
  windowsOnly('assigns the worker before it spawns descendants and kills the whole job', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-job-'));
    const childPidFile = path.join(directory, 'child.pid');
    const workerScript = `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      process.stdin.once('data', () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore', windowsHide: true
        });
        fs.writeFileSync(process.argv[1], String(child.pid));
        setInterval(() => {}, 1000);
      });
    `;
    const worker = spawn(process.execPath, ['-e', workerScript, childPidFile], {
      stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true
    });
    let stderr = '';
    worker.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const job = spawn(process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-WorkerPid', String(worker.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let ready = '';
    let jobError = '';
    job.stdout.on('data', (chunk) => { ready += String(chunk); });
    job.stderr.on('data', (chunk) => { jobError += String(chunk); });
    try {
      await waitFor(async () => ready.includes('READY'));
      worker.stdin.write('go\n');
      await waitFor(async () => {
        try { return Boolean((await fs.readFile(childPidFile, 'utf8')).trim()); } catch { return false; }
      });
      const descendant = Number(await fs.readFile(childPidFile, 'utf8'));
      expect(alive(descendant)).toBe(true);
      job.stdin.end('STOP\n');
      await waitFor(async () => !alive(worker.pid!) && !alive(descendant));
    } finally {
      if (worker.exitCode === null) worker.kill();
      if (job.exitCode === null) job.kill();
      await fs.rm(directory, { recursive: true, force: true });
    }
    expect(jobError).toBe('');
    expect(stderr).not.toContain('sensitive');
  }, 30_000);

  windowsOnly('ignores a stop request after the helper has already exited', async () => {
    const job = createWindowsTerminalJob(99_999_999);
    await expect(job.ready).rejects.toThrow();
    await job.exited;
    expect(() => job.stop()).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 100));
  }, 30_000);
});
