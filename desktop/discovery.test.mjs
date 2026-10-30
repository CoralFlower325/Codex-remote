import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { discoverInstallations, preferredInstallation } from './discovery.mjs';

describe('installation discovery', () => {
  it.each(['win32', 'darwin'])('prefers the registered %s service without executing controls', async (platform) => {
    const owner = path.resolve('synthetic installation with spaces');
    const nearby = path.resolve('synthetic nearby checkout');
    const execute = vi.fn().mockResolvedValue(platform === 'win32' ? JSON.stringify([owner]) : owner);
    const inspect = vi.fn(async (root) => {
      if (![owner, nearby].includes(root)) throw new Error('Not an installation');
      return { root, version: '0.1.12' };
    });
    const found = await discoverInstallations({ platform, home: path.resolve('synthetic home'),
      nearby: [owner, nearby], execute, inspect });
    expect(found).toEqual([
      { root: owner, version: '0.1.12', source: 'service' },
      { root: nearby, version: '0.1.12', source: 'nearby' }
    ]);
    expect(preferredInstallation(found)?.root).toBe(owner);
    expect(preferredInstallation(found, nearby)?.root).toBe(nearby);
    expect(inspect.mock.calls.filter(([root]) => root === owner)).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2].timeout).toBe(5000);
    expect(execute.mock.calls[0][1].join(' ')).not.toMatch(/Start|Stop|Register/);
    if (platform === 'darwin') expect(execute.mock.calls[0][1]).toContain('Print :WorkingDirectory');
  });
  it('finds a common installation when no service exists, and ignores invalid directories', async () => {
    const home = path.resolve('synthetic home');
    const root = path.join(home, 'Documents', 'codex-remote');
    const found = await discoverInstallations({ platform: 'darwin', home,
      execute: vi.fn().mockRejectedValue(new Error('No plist')),
      inspect: async (candidate) => {
        if (candidate !== root) throw new Error('Not a built installation');
        return { root, version: '0.1.11' };
      } });
    expect(preferredInstallation(found)?.root).toBe(root);
    expect(found[0].source).toBe('common');
  });
  it('deduplicates canonical paths and never guesses between multiple unregistered installations', async () => {
    const root = path.resolve('canonical root');
    const found = await discoverInstallations({ platform: 'win32', home: path.resolve('synthetic home'),
      nearby: ['alias-one', 'alias-two', 'another'],
      execute: vi.fn().mockResolvedValue('[]'),
      inspect: async (candidate) => {
        if (candidate.startsWith('alias-')) return { root, version: '0.1.12' };
        if (candidate === 'another') return { root: path.resolve(candidate), version: '0.1.12' };
        throw new Error('Not an installation');
      } });
    expect(found).toHaveLength(2);
    expect(preferredInstallation(found)).toBeNull();
    expect(preferredInstallation([])).toBeNull();
  });
  it('retains a valid custom selection outside common folders during another scan', async () => {
    const custom = path.resolve('custom volume/remote host');
    const service = path.resolve('another service');
    const found = await discoverInstallations({ platform: 'win32', home: path.resolve('synthetic home'),
      nearby: [custom], execute: vi.fn().mockResolvedValue(JSON.stringify([service])),
      inspect: async (candidate) => {
        if (![custom, service].includes(candidate)) throw new Error('Not an installation');
        return { root: candidate, version: '0.1.12' };
      } });
    expect(found.some((item) => item.root === custom)).toBe(true);
    expect(preferredInstallation(found, custom)?.root).toBe(custom);
    expect(preferredInstallation(found, 'deleted installation')?.root).toBe(service);
  });
});
