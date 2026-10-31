import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { repairControl, readDiagnosticLogs } from './diagnostics.mjs';

describe('scoped native connection repair', () => {
  it('uses a separate owned tunnel or server target and refuses disabled/external services', async () => {
    const info = { root: 'selected installation', localUrl: 'http://127.0.0.1:4545' };
    const execute = vi.fn().mockResolvedValue('{"running":true,"enabled":true,"tunnelManaged":true}');
    await repairControl(info, 'Tunnel', execute, 'win32');
    expect(execute.mock.calls[1][1]).toContain('Tunnel');
    expect(execute.mock.calls[1][1]).toContain(info.root);
    expect(execute.mock.calls[1][1]).not.toContain('Stop');
    execute.mockClear();
    await repairControl(info, 'Server', execute, 'win32');
    expect(execute.mock.calls[1][1]).toContain('Server');
    execute.mockResolvedValue('{"running":true,"enabled":true,"tunnelManaged":false}');
    await expect(repairControl(info, 'Tunnel', execute, 'darwin')).rejects.toThrow('外部');
    execute.mockResolvedValue('{"running":false,"enabled":false,"tunnelManaged":true}');
    await expect(repairControl(info, 'Server', execute, 'win32')).rejects.toThrow('开启');
    await expect(repairControl(info, '../Desktop', execute, 'win32')).rejects.toThrow('未知');
  });
  it('bounds and redacts selected logs without reading arbitrary paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-log-test-'));
    try {
      await fs.mkdir(path.join(root, 'data'));
      await fs.writeFile(path.join(root, 'data/server.err.log'), 'x'.repeat(20_000) + '\npassword=secret token=hidden Cookie=private');
      const logs = await readDiagnosticLogs({ root }, 'Server');
      expect(logs.length).toBeLessThan(8400);
      for (const secret of ['=secret', '=hidden', '=private']) expect(logs).not.toContain(secret);
      await expect(readDiagnosticLogs({ root }, '../auth')).rejects.toThrow('未知');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
