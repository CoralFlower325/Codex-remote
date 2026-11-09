import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateLoopbackPort,
  clearTunnelMetricsState,
  tunnelMetricsPath,
  writeTunnelMetricsState
} from './tunnel-metrics-state.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('owned tunnel metrics state', () => {
  it('allocates a loopback port and removes only the current owner state', async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-metrics-'));
    directories.push(root);
    await writeTunnelMetricsState(root, {
      port, pid: 42, owner: 'owner-a', startedAt: 100
    });
    expect(JSON.parse(await fs.readFile(tunnelMetricsPath(root), 'utf8'))).toMatchObject({
      port, pid: 42, owner: 'owner-a'
    });
    await clearTunnelMetricsState(root, 'owner-b');
    expect((await fs.stat(tunnelMetricsPath(root))).isFile()).toBe(true);
    await clearTunnelMetricsState(root, 'owner-a');
    await expect(fs.stat(tunnelMetricsPath(root))).rejects.toHaveProperty('code', 'ENOENT');
  });
});
