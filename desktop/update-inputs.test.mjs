import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runtimeNode } from './update-inputs.mjs';

describe('manager runtime selection', () => {
  it('prefers the managed ProgramData Node before a PATH runtime', async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-runtime-'));
    try {
      const staged = path.join(runtimeRoot, 'node-22.19.0-127.exe');
      await fs.writeFile(staged, '', 'utf8');
      const execute = vi.fn(async (_file, args) => {
        if (args[0] === '--version') return 'v22.19.0';
        if (args[0] === '-p') return '127';
        if (args[0] === 'node') return path.join(os.tmpdir(), 'path-node.exe');
        return '';
      });
      await expect(runtimeNode(execute, { platform: 'win32', runtimeRoot })).resolves.toMatchObject({
        node: staged,
        version: '22.19.0',
        modules: '127'
      });
      expect(execute.mock.calls.filter(([file]) => file === 'where.exe')).toHaveLength(0);
      expect(execute.mock.calls[0][0]).toBe(staged);
    } finally {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});
