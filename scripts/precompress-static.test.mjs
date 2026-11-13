import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { precompressDirectory } from './precompress-static.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('static precompression', () => {
  it('writes Brotli sidecars for text assets and leaves binary files alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-precompress-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>Hello</h1>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'export const answer = 42;\n'.repeat(100));
    fs.writeFileSync(path.join(root, 'assets', 'image.png'), Buffer.from([0, 1, 2, 3]));

    const result = precompressDirectory(root);

    expect(result).toMatchObject({ files: 2, inputBytes: expect.any(Number), outputBytes: expect.any(Number) });
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
    expect(fs.existsSync(path.join(root, 'index.html.br'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'assets', 'app.js.br'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'assets', 'image.png.br'))).toBe(false);
  });
});
