import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { listDesktopProcesses, restartDesktopForRemote } from './desktop-recovery.mjs';

const environment = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  HOME: '/Users/test'
};
const executable = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__test\\app\\ChatGPT.exe';

describe('Desktop recovery process selection', () => {
  it('returns only trusted top-level Desktop processes and reads their debug port', async () => {
    const execute = vi.fn().mockResolvedValue(JSON.stringify([
      { ProcessId: 10, ExecutablePath: executable, CommandLine: `"${executable}" --remote-debugging-port=9444` },
      { ProcessId: 11, ExecutablePath: executable, CommandLine: `"${executable}"` },
      { ProcessId: 12, ExecutablePath: executable, CommandLine: `"${executable}" --type=renderer --remote-debugging-port=9555` },
      { ProcessId: 13, ExecutablePath: 'C:\\Temp\\ChatGPT.exe', CommandLine: '"C:\\Temp\\ChatGPT.exe" --remote-debugging-port=9666' }
    ]));
    expect(await listDesktopProcesses({ platform: 'win32', environment, execute })).toEqual([
      expect.objectContaining({ pid: 10, debugPort: 9444 }),
      expect.objectContaining({ pid: 11, debugPort: 0 })
    ]);
  });

  it('detects a trusted macOS app process without requiring a fixed port', async () => {
    const execute = vi.fn().mockResolvedValue([
      ' 22 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      ' 23 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --type=renderer --remote-debugging-port=9229'
    ].join('\n'));
    expect(await listDesktopProcesses({ platform: 'darwin', environment, execute }))
      .toEqual([expect.objectContaining({ pid: 22, debugPort: 0, platform: 'darwin' })]);
  });

  it('stops the exact validated Desktop process before launching it with loopback debugging', async () => {
    const execute = vi.fn().mockResolvedValue('');
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await restartDesktopForRemote({ pid: 31, executable, platform: 'win32' }, {
      port: 9229, environment, execute, spawnProcess
    });
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '-ProcessId', '31', '-ExecutablePath', executable
    ]));
    expect(spawnProcess).toHaveBeenCalledWith(executable,
      ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9229'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }));
    expect(child.unref).toHaveBeenCalled();
  });

  it('refuses to stop an executable outside the trusted installation roots', async () => {
    await expect(restartDesktopForRemote({
      pid: 44, executable: 'C:\\Temp\\ChatGPT.exe', platform: 'win32'
    }, { port: 9229, environment, execute: vi.fn(), spawnProcess: vi.fn() }))
      .rejects.toThrow('受信任');
  });
});
