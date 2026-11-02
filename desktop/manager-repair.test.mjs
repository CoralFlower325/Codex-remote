import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagerSession } from './manager-session.mjs';
import { health } from './controller.mjs';
import { repairControl } from './diagnostics.mjs';
import { discoverMacTunnels } from './macos-tunnel.mjs';
import { pendingUpdate } from './update-transaction.mjs';

vi.mock('./controller.mjs', () => ({
  health: vi.fn(), installation: vi.fn(), control: vi.fn(), serviceStatus: vi.fn(),
  portListening: vi.fn(), startupReady: vi.fn()
}));
vi.mock('./diagnostics.mjs', () => ({ repairControl: vi.fn() }));
vi.mock('./macos-tunnel.mjs', () => ({ discoverMacTunnels: vi.fn() }));
vi.mock('./update-transaction.mjs', () => ({ pendingUpdate: vi.fn(), recoverPendingUpdate: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const roots = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-repair-'));
  roots.push(root);
  const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };
  const session = createManagerSession({
    app: { getPath: () => root, getVersion: () => 'test' }, dialog, shell: {},
    getWindow: () => null, publish: vi.fn(), here: root, fetchRelease: vi.fn()
  });
  session.settings.root = root;
  pendingUpdate.mockResolvedValue(null);
  const publicEntry = { configured: true, reachable: false, detail: 'HTTP 530', state: 'http-error' };
  health.mockResolvedValue({ root, checkedAt: 1, state: 'healthy', publicEntry });
  discoverMacTunnels.mockResolvedValue([{ id: 'system/com.cloudflare.cloudflared', label: 'com.cloudflare.cloudflared', domain: 'system' }]);
  return { session, dialog, publicEntry };
}

describe('manager external tunnel repair', () => {
  it('cancels the short confirmation without any service mutation', async () => {
    const { session, dialog } = await fixture();
    dialog.showMessageBox.mockResolvedValue({ response: 0 });
    await session.repair('Tunnel');
    expect(repairControl).not.toHaveBeenCalled();
    expect(dialog.showMessageBox.mock.calls[0][1].message).toContain('com.cloudflare.cloudflared');
  });
  it('requires a selection for ambiguous jobs, then confirms only the selected job', async () => {
    const { session, dialog, publicEntry } = await fixture();
    const chosen = { id: 'gui/501/homebrew.mxcl.cloudflared', label: 'homebrew.mxcl.cloudflared', domain: 'gui/501' };
    discoverMacTunnels.mockResolvedValue([
      { id: 'system/com.cloudflare.cloudflared', label: 'com.cloudflare.cloudflared', domain: 'system' }, chosen
    ]);
    dialog.showMessageBox.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 1 });
    health.mockResolvedValue({ root: session.settings.root, checkedAt: 2, state: 'healthy',
      publicEntry: { ...publicEntry, reachable: true, detail: 'ok' } });
    await session.repair('Tunnel');
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(repairControl).toHaveBeenCalledWith(expect.any(Object), 'Tunnel', undefined, 'darwin', chosen);
    expect(session.state.result).toContain('复检通过');
  });
  it('does not claim public recovery after a successful restart with failed probes', async () => {
    const { session } = await fixture();
    vi.useFakeTimers();
    const task = session.repair('Tunnel');
    await vi.runAllTimersAsync();
    await task;
    expect(repairControl).toHaveBeenCalledTimes(1);
    expect(session.state.result).toContain('尚未确认恢复');
    expect(session.state.connectionReport.reachable).toBe(false);
    expect(session.state.result).not.toContain('复检通过');
  });
  it('gives an actionable missing-service error without touching unrelated jobs', async () => {
    const { session, dialog } = await fixture();
    discoverMacTunnels.mockResolvedValue([]);
    await expect(session.repair('Tunnel')).rejects.toThrow('注册已有隧道');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(repairControl).not.toHaveBeenCalled();
  });
});
