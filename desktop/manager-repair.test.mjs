import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagerSession } from './manager-session.mjs';
import { health, probePublicEntries, mergePublicEntries } from './controller.mjs';
import { repairControl } from './diagnostics.mjs';
import { discoverMacTunnels } from './macos-tunnel.mjs';
import { pendingUpdate } from './update-transaction.mjs';
import { listDesktopProcesses, restartDesktopForRemote } from './desktop-recovery.mjs';

vi.mock('./controller.mjs', () => ({
  health: vi.fn(), installation: vi.fn(), control: vi.fn(), serviceStatus: vi.fn(),
  portListening: vi.fn(), startupReady: vi.fn(), probePublicEntries: vi.fn(),
  mergePublicEntries: vi.fn((status, publicEntries) => ({ ...status, publicEntries,
    publicEntry: publicEntries[0] ?? status.publicEntry }))
}));
vi.mock('./diagnostics.mjs', () => ({ repairControl: vi.fn() }));
vi.mock('./macos-tunnel.mjs', () => ({ discoverMacTunnels: vi.fn() }));
vi.mock('./update-transaction.mjs', () => ({ pendingUpdate: vi.fn(), recoverPendingUpdate: vi.fn() }));
vi.mock('./desktop-recovery.mjs', () => ({ listDesktopProcesses: vi.fn(), restartDesktopForRemote: vi.fn() }));

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
  probePublicEntries.mockResolvedValue([publicEntry]);
  listDesktopProcesses.mockResolvedValue([]);
  restartDesktopForRemote.mockResolvedValue({ pid: 1, port: 9229 });
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
    probePublicEntries.mockResolvedValue([{ ...publicEntry, reachable: true, detail: 'ok', state: 'reachable' }]);
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
  it('confirms and verifies a managed Windows SSH reverse tunnel independently', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-ssh-repair-'));
    roots.push(root);
    const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };
    const session = createManagerSession({
      app: { getPath: () => root, getVersion: () => 'test' }, dialog, shell: {},
      getWindow: () => null, publish: vi.fn(), here: root, fetchRelease: vi.fn()
    });
    session.settings.root = root;
    pendingUpdate.mockResolvedValue(null);
    const publicEntry = { configured: true, reachable: true, detail: 'ok', state: 'reachable' };
    health.mockResolvedValue({ root, checkedAt: 1, state: 'healthy', publicEntry,
      sshTunnel: { configured: true, managed: true, ready: true } });
    probePublicEntries.mockResolvedValue([publicEntry]);
    await session.repair('SshTunnel');
    expect(repairControl).toHaveBeenCalledWith(expect.objectContaining({
      sshTunnel: expect.objectContaining({ managed: true })
    }), 'SshTunnel', undefined, 'win32', undefined);
    expect(dialog.showMessageBox.mock.calls[0][1].message).toContain('SSH 反向隧道');
    expect(session.state.result).toContain('主入口复检通过');
  });
  it('fails fast when Desktop was started without a debug endpoint', async () => {
    const { session } = await fixture();
    health.mockResolvedValue({ root: session.settings.root, checkedAt: 2, state: 'degraded',
      service: { running: true }, backend: { ready: true }, desktop: false,
      desktopDebug: { port: 9229, reachable: false, targetReady: false },
      publicEntry: { configured: true, reachable: false, state: 'unchecked', detail: 'pending' } });
    await expect(session.repair('Server')).rejects.toThrow('由 Remote 重启 Codex');
    expect(repairControl).not.toHaveBeenCalled();
    expect(session.state.error).toContain('Remote 服务无需重启');
  });
  it('restarts direct Codex only after the explicit Desktop recovery action', async () => {
    const { session, dialog } = await fixture();
    health.mockResolvedValue({ root: session.settings.root, checkedAt: 2, state: 'degraded',
      service: { running: true }, backend: { ready: true }, desktop: false,
      desktopDebug: { port: 9229, reachable: false, targetReady: false },
      publicEntry: { configured: true, reachable: true, state: 'reachable', detail: 'ok' } });
    listDesktopProcesses.mockResolvedValue([{ pid: 123, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      debugPort: 0, platform: 'darwin' }]);
    await session.repair('Desktop');
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(restartDesktopForRemote).toHaveBeenCalledWith(expect.objectContaining({ pid: 123 }),
      { port: 9229 });
    expect(session.state.result).toContain('正在后台恢复');
  });
  it('does not restart an already-debuggable Codex while its bridge reconnects', async () => {
    const { session, dialog } = await fixture();
    health.mockResolvedValue({ root: session.settings.root, checkedAt: 2, state: 'degraded',
      service: { running: true }, backend: { ready: true }, desktop: false,
      desktopDebug: { port: 9229, reachable: false, targetReady: false },
      publicEntry: { configured: true, reachable: true, state: 'reachable', detail: 'ok' } });
    listDesktopProcesses.mockResolvedValue([{ pid: 456, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      debugPort: 9444, platform: 'darwin' }]);
    await session.repair('Desktop');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(restartDesktopForRemote).not.toHaveBeenCalled();
    expect(session.state.result).toContain('自动重连');
  });
});
