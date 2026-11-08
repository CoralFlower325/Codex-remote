import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { boundedLogWriter } from './rotating-log.mjs';

const execute = promisify(execFile);
const temporary = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-service-log-'));
  temporary.push(root);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'node_modules/dotenv'), { recursive: true });
  for (const name of ['background-service.mjs', 'rotating-log.mjs']) {
    await fs.copyFile(new URL(name, import.meta.url), path.join(root, 'scripts', name));
  }
  await fs.writeFile(path.join(root, 'node_modules/dotenv/package.json'),
    JSON.stringify({ name: 'dotenv', type: 'module', exports: { './config': './config.js' } }));
  await fs.writeFile(path.join(root, 'node_modules/dotenv/config.js'), '');
  const entry = path.join(root, 'entry.mjs');
  await fs.writeFile(entry, source);
  const launch = () => execute(process.execPath, [path.join(root, 'scripts/background-service.mjs'), entry, 'argument'],
    { cwd: root, timeout: 10_000, env: { ...process.env, DATA_DIR: path.join(root, 'logs') } });
  return { root, entry, launch };
}

describe('owned service output capture', () => {
  it('captures all JS output through bounded files and keeps the original backend PID and arguments', async () => {
    const { root, entry, launch } = await fixture(`
      console.log("console-output");
      process.stdout.write("direct-output\\\\n");
      process.stderr.write("direct-error\\\\n");
      process.emitWarning("service-warning");
      console.log(JSON.stringify({ entry: process.argv[1], argument: process.argv[2], pid: process.pid }));
      process.stdout.write("X".repeat(6 * 1024 * 1024));
    `);
    const result = await launch();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    const files = await fs.readdir(path.join(root, 'logs'));
    for (const name of files) expect((await fs.stat(path.join(root, 'logs', name))).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    const output = await fs.readFile(path.join(root, 'logs/server.out.log.1'), 'utf8');
    expect(output).toContain('console-output');
    expect(output).toContain('direct-output');
    expect(output).toContain(JSON.stringify(entry));
    expect(output).toContain('"argument":"argument"');
    const error = await fs.readFile(path.join(root, 'logs/server.err.log'), 'utf8');
    expect(error).toContain('direct-error');
    expect(error).toContain('service-warning');
  });

  it.each(['throw new Error("module-start-failed")', 'setImmediate(() => { throw new Error("uncaught-failed") })'])(
    'captures startup and uncaught failures before terminating: %s', async source => {
      const { root, launch } = await fixture(source);
      await expect(launch()).rejects.toMatchObject({ code: 1 });
      expect(await fs.readFile(path.join(root, 'logs/server.err.log'), 'utf8')).toContain(
        source.includes('module-start') ? 'module-start-failed' : 'uncaught-failed');
    });

  it('keeps a service alive when its log directory cannot be written', async () => {
    const { root, launch } = await fixture('console.log("survived"); console.error("survived");');
    await fs.writeFile(path.join(root, 'logs'), 'directory blocked');
    await expect(launch()).resolves.toMatchObject({ stdout: '', stderr: '' });
  });

  it('reports dropped writes when storage becomes writable again', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-log-recovery-'));
    temporary.push(root);
    const target = path.join(root, 'log');
    await fs.mkdir(target);
    const write = boundedLogWriter(target);
    expect(write('blocked')).toBe(false);
    await fs.rmdir(target);
    expect(write('recovered')).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toContain('1 writes were dropped');
  });
});
