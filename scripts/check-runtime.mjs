import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnTerminal } from '../dist-server/server/terminal-process.js';
import express from 'express';
import WebSocket from 'ws';
import webPush from 'web-push';
import headless from '@xterm/headless';

const require = createRequire(import.meta.url);
if (!express || !WebSocket || !webPush || !headless.Terminal) throw new Error('Runtime dependency unavailable.');
await fs.access('dist/client/index.html');
await fs.access('dist-server/server/index.js');
await fs.access('dist-server/server/terminal-worker.js');
await fs.access('scripts/rotating-log.mjs');
await fs.access('scripts/background-service.mjs');
await fs.access('desktop/release-signature.mjs');
await fs.access('desktop/release-keys.mjs');
await fs.access('dist/desktop-relay/automations.js');
const { validAutomationRule } = await import('../dist-server/shared/automation-schedule.js');
if (!validAutomationRule('RRULE:FREQ=DAILY')) throw new Error('Runtime RRULE parser unavailable.');
require.resolve('node-pty');
// Exercise the shipped IPC worker, native binary and macOS helper in isolation.
await new Promise((resolve, reject) => {
  const terminal = spawnTerminal(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    process.platform === 'win32' ? ['/d', '/c', 'echo runtime-ready'] : ['-c', 'echo runtime-ready'],
    { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  let output = '';
  let timedOut = false;
  let cleanupTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    terminal.kill();
    cleanupTimer = setTimeout(() => reject(new Error('Runtime terminal cleanup timeout.')), 3000);
  }, 10_000);
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
    if (timedOut || exitCode !== 0 || !output.includes('runtime-ready')) reject(new Error('Runtime terminal check failed.'));
    else resolve();
  });
});
console.log('运行包环境检查通过。');
