import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';

it.skipIf(process.platform !== 'win32')('runs a windowless task in a path with spaces and Unicode, captures logs and propagates failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote background \u6d4b\u8bd5 & '));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'dist-server/server'), { recursive: true });
    for (const file of ['run-hidden-windows.vbs', 'background-task-windows.mjs']) {
      await fs.copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(root, 'scripts', file));
    }
    await fs.writeFile(path.join(root, 'dist-server/server/index.js'),
      'console.log("captured stdout");console.error("captured stderr");process.exitCode=42;', 'utf8');
    await expect(run(path.join(process.env.WINDIR, 'System32/wscript.exe'),
      ['//B', '//Nologo', path.join(root, 'scripts/run-hidden-windows.vbs'), process.execPath,
        path.join(root, 'scripts/background-task-windows.mjs'), 'server'], { timeout: 15_000 }))
      .rejects.toThrow('42');
    expect(await fs.readFile(path.join(root, 'data/server.out.log'), 'utf8')).toContain('captured stdout');
    expect(await fs.readFile(path.join(root, 'data/server.err.log'), 'utf8')).toContain('captured stderr');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);
