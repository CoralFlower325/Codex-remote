import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupStalePreviewDirectories, OfficePreviews, runOffice } from './office-preview.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-preview-test-'));
  directories.push(root);
  const source = path.join(root, 'sample.docx');
  await fs.writeFile(source, 'synthetic');
  return { root, source };
}

it('serializes conversions, shares duplicate in-flight reads and releases finished bytes', async () => {
  const { source } = await fixture();
  let finish!: (value: Buffer) => void;
  const render = vi.fn(() => new Promise<Buffer>(resolve => { finish = resolve; }));
  const previews = new OfficePreviews(render);
  const a = previews.read(source), b = previews.read(source);
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  finish(Buffer.from('%PDF-result'));
  expect(await a).toBe(await b);
  const later = previews.read(source);
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
  finish(Buffer.from('%PDF-next'));
  expect((await later).toString()).toBe('%PDF-next');
});

it('bounds pending work and continues after a failed conversion without changing originals', async () => {
  const { root } = await fixture();
  const sources = await Promise.all(['a.docx', 'b.xlsx', 'c.pptx', 'd.rtf'].map(async name => {
    const file = path.join(root, name);
    await fs.writeFile(file, name);
    return file;
  }));
  let fail!: (error: Error) => void;
  const render = vi.fn<(...args: string[]) => Promise<Buffer>>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValue(Buffer.from('%PDF-next'));
  const previews = new OfficePreviews(render);
  const first = previews.read(sources[0]!).catch(error => error);
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  const second = previews.read(sources[1]!), third = previews.read(sources[2]!);
  await vi.waitFor(() => expect((previews as any).pending.size).toBe(3));
  await expect(previews.read(sources[3]!)).rejects.toMatchObject({ status: 429 });
  expect(render).toHaveBeenCalledOnce();
  fail(new Error('Synthetic failure'));
  expect(await first).toHaveProperty('message', 'Synthetic failure');
  await Promise.all([second, third]);
  expect(render).toHaveBeenCalledTimes(3);
  expect(await fs.readFile(sources[0]!, 'utf8')).toBe('a.docx');
});

it('rejects unsupported paths, missing files and oversized inputs before invoking the converter', async () => {
  const { root } = await fixture();
  const render = vi.fn();
  const previews = new OfficePreviews(render);
  await expect(previews.read('relative.docx')).rejects.toMatchObject({ status: 400 });
  await expect(previews.read(path.join(root, 'missing.docx'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(previews.read(path.join(root, 'script.exe'))).rejects.toMatchObject({ status: 400 });
  const source = path.join(root, 'large.docx');
  const file = await fs.open(source, 'w');
  await file.truncate(32 * 1024 * 1024 + 1);
  await file.close();
  await expect(previews.read(source)).rejects.toMatchObject({ status: 413 });
  expect(render).not.toHaveBeenCalled();
});

it('rejects text masquerading as an OOXML document before converter discovery', async () => {
  const { source } = await fixture();
  await expect(new OfficePreviews().read(source)).rejects.toMatchObject({ status: 422 });
});

it('terminates only an owned converter process tree when its time budget expires', async () => {
  const { root } = await fixture();
  const marker = path.join(root, 'child.pid');
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)); setInterval(()=>{},1000);`;
  const result = runOffice(process.execPath, ['-e', script], process.env, 3000).catch(error => error);
  await vi.waitFor(() => fs.stat(marker), { timeout: 2500 });
  const pid = Number(await fs.readFile(marker, 'utf8'));
  expect(await result).toHaveProperty('message', expect.stringContaining('超时'));
  await vi.waitFor(() => {
    let exists = false;
    try { process.kill(pid, 0); exists = true; } catch { /* Process exited. */ }
    expect(exists).toBe(false);
  });
}, 10_000);

it('removes only stale owned preview directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-preview-cleanup-'));
  directories.push(root);
  const stale = path.join(root, 'codex-remote-preview-stale');
  const fresh = path.join(root, 'codex-remote-preview-fresh');
  const foreign = path.join(root, 'another-application');
  await Promise.all([stale, fresh, foreign].map(directory => fs.mkdir(directory)));
  const now = Date.now();
  await fs.utimes(stale, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));
  expect(await cleanupStalePreviewDirectories(root, now)).toBe(1);
  await expect(fs.stat(stale)).rejects.toHaveProperty('code', 'ENOENT');
  expect((await fs.stat(fresh)).isDirectory()).toBe(true);
  expect((await fs.stat(foreign)).isDirectory()).toBe(true);
});
