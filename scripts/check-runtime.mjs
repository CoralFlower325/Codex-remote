import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node-pty';
import express from 'express';
import WebSocket from 'ws';
import webPush from 'web-push';
import headless from '@xterm/headless';

const require = createRequire(import.meta.url);
if (!express || !WebSocket || !webPush || !headless.Terminal) throw new Error('Runtime dependency unavailable.');
await fs.access('dist/client/index.html');
await fs.access('dist-server/server/index.js');
require('node-pty');
// Exercise the native binary and macOS spawn-helper with no Desktop connection.
await new Promise((resolve, reject) => {
  const terminal = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    process.platform === 'win32' ? ['/d', '/c', 'echo runtime-ready'] : ['-c', 'echo runtime-ready'],
    { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  let output = '';
  const timer = setTimeout(() => { terminal.kill(); reject(new Error('Runtime terminal timeout.')); }, 10_000);
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode !== 0 || !output.includes('runtime-ready')) reject(new Error('Runtime terminal check failed.'));
    else resolve();
  });
});
console.log('运行包环境检查通过。');
// The Windows ConPTY helper can retain a worker handle after terminal exit.
// This standalone probe owns no other work or services.
process.exit(0);
