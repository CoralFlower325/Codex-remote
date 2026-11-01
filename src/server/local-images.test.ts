import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LocalImages } from './local-images.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-images-'));
  temporary.push(root);
  const source = path.join(root, 'clipboard.png');
  await fs.writeFile(source, 'synthetic image bytes');
  const directory = path.join(root, 'retained');
  return { source, directory, images: new LocalImages(directory) };
}

it('preserves native local attachments across temporary-file cleanup and server restart', async () => {
  const { images, source, directory } = await fixture();
  await images.remember({ type: 'userMessage', content: [{ type: 'localImage', path: source }] });
  await fs.unlink(source);
  const retained = await new LocalImages(directory).resolve(source);
  expect(retained).not.toBe(source);
  expect(await fs.readFile(retained!, 'utf8')).toBe('synthetic image bytes');
});

it('shares concurrent captures and persists distinct paths without losing entries', async () => {
  const { images, source, directory } = await fixture();
  const second = path.join(path.dirname(source), 'another.png');
  await fs.writeFile(second, 'another image');
  const [first, duplicate] = await Promise.all([images.resolve(source), images.resolve(source), images.resolve(second)]);
  expect(first).toBe(duplicate);
  expect((await fs.readdir(directory)).filter(name => name.endsWith('.png'))).toHaveLength(2);
  await fs.unlink(source); await fs.unlink(second);
  const restarted = new LocalImages(directory);
  expect(await restarted.resolve(source)).toBe(first);
  expect(await restarted.resolve(second)).not.toBeNull();
});

it('serves the current file when a referenced path is edited', async () => {
  const { images, source } = await fixture();
  await images.resolve(source);
  await fs.writeFile(source, 'updated image bytes');
  expect(await fs.readFile((await images.resolve(source))!, 'utf8')).toBe('updated image bytes');
});

it('does not invent deleted images, retain non-image files, or archive model activity', async () => {
  const { images, source, directory } = await fixture();
  await images.remember({ type: 'imageView', path: source });
  expect(await fs.stat(directory).catch(() => null)).toBeNull();
  expect(await images.resolve(`${source}.missing.png`)).toBeNull();
  expect(await images.resolve(source.replace('.png', '.txt'))).toBeNull();
});

it('isolates a damaged attachment index without overwriting it or losing access to original images', async () => {
  const { source, directory } = await fixture();
  await fs.mkdir(directory, { recursive: true });
  const index = path.join(directory, 'index.json');
  await fs.writeFile(index, '{"broken":', 'utf8');
  const images = new LocalImages(directory);
  expect(await images.resolve(source)).toBe(source);
  await fs.unlink(source);
  await expect(images.resolve(source)).rejects.toThrow('索引');
  expect(await fs.readFile(index, 'utf8')).toBe('{"broken":');
});
