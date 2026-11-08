import { describe, expect, it, vi } from 'vitest';
import { discoverWindowsDesktopDebugPorts, parseWindowsDesktopDebugPorts,
  parseWindowsDesktopDiscovery } from './desktop-debug-port.js';

const environment = {
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
  SystemRoot: 'C:\\Windows'
};
const executable = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';

describe('Windows Desktop debug-port discovery', () => {
  it('extracts only loopback debug ports from trusted top-level Desktop processes', () => {
    expect(parseWindowsDesktopDebugPorts([
      { ProcessId: 10, ExecutablePath: executable,
        CommandLine: `"${executable}" --remote-debugging-port=4952`,
        CreationDate: '2026-11-08T14:16:23.381585Z' },
      { ProcessId: 11, ExecutablePath: executable,
        CommandLine: `"${executable}" --type=renderer --remote-debugging-port=6333`,
        CreationDate: '2026-11-08T14:17:23.381585Z' }
    ], environment)).toEqual([4952]);
  });

  it('supports explicit loopback addresses and rejects non-loopback or unsafe paths', () => {
    expect(parseWindowsDesktopDebugPorts([
      { ExecutablePath: executable,
        CommandLine: `"${executable}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=4952` },
      { ExecutablePath: 'C:\\Temp\\ChatGPT.exe',
        CommandLine: '"C:\\Temp\\ChatGPT.exe" --remote-debugging-port=7000' },
      { ExecutablePath: executable,
        CommandLine: `"${executable}" --remote-debugging-address=0.0.0.0 --remote-debugging-port=7001` },
      { ExecutablePath: executable,
        CommandLine: `"${executable}" --remote-debugging-port=0` }
    ], environment)).toEqual([4952]);
  });

  it('deduplicates ports and prefers the newest process version', () => {
    expect(parseWindowsDesktopDebugPorts([
      { ExecutablePath: executable, CommandLine: `"${executable}" --remote-debugging-port=4952`,
        CreationDate: '/Date(1794146400000)/' },
      { ExecutablePath: executable, CommandLine: `"${executable}" --remote-debugging-port=6333`,
        CreationDate: '2026-11-08T15:00:00Z' },
      { ExecutablePath: executable, CommandLine: `"${executable}" --remote-debugging-port=4952`,
        CreationDate: '2026-11-08T13:00:00Z' }
    ], environment)).toEqual([6333, 4952]);
  });

  it('fails closed for malformed output and only runs discovery on Windows', async () => {
    expect(parseWindowsDesktopDiscovery('{broken', environment)).toEqual([]);
    const execute = vi.fn();
    expect(await discoverWindowsDesktopDebugPorts({ platform: 'darwin', environment, execute })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses a fixed PowerShell path and parses the bounded process response', async () => {
    const output = JSON.stringify([{ ExecutablePath: executable,
      CommandLine: `"${executable}" --remote-debugging-port=4952` }]);
    const execute = vi.fn(async () => output);
    expect(await discoverWindowsDesktopDebugPorts({ platform: 'win32', environment, execute }))
      .toEqual([4952]);
    expect(execute).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command'])
    );
  });
});
