import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TerminalServerMessage } from '../shared/terminal.js';
import { TerminalManager, terminalShell } from './terminal-manager.js';

const command = (windows: string, unix: string) => `${process.platform === 'win32' ? windows : unix}\r`;

describe('workspace terminals with a real PTY', () => {
  let directory: string;
  let manager: TerminalManager;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-'));
    manager = new TerminalManager(directory);
  });

  afterEach(async () => {
    manager.dispose();
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  async function waitForOutput(messages: TerminalServerMessage[], text: string) {
    await expect.poll(() => messages.filter((message) => message.type === 'terminal.output')
      .map((message) => message.data).join(''), { timeout: 20_000, interval: 50 }).toContain(text);
  }

  function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  it('starts in the workspace and preserves output and shell state across detach/reattach', async () => {
    const workspace = manager.open();
    const id = manager.create(workspace);
    const messages: TerminalServerMessage[] = [];
    const detach = manager.attach(workspace, id, (message) => messages.push(message));
    manager.input(workspace, id, command(
      "$env:REMOTE_TERMINAL_TEST='retained'; Write-Output ('CWD=' + (Get-Location).Path)",
      "export REMOTE_TERMINAL_TEST=retained; printf 'CWD=%s\\n' \"$PWD\""
    ));
    await waitForOutput(messages, `CWD=${workspace.cwd}`);
    detach();
    manager.input(workspace, id, command(
      "Write-Output ('AFTER_' + $env:REMOTE_TERMINAL_TEST)",
      "printf 'AFTER_%s\\n' \"$REMOTE_TERMINAL_TEST\""
    ));
    const restored: TerminalServerMessage[] = [];
    manager.attach(workspace, id, (message) => restored.push(message));
    await expect.poll(() => JSON.stringify(restored), { timeout: 20_000 }).toContain('AFTER_retained');
    const snapshot: TerminalServerMessage[] = [];
    manager.attach(workspace, id, (message) => snapshot.push(message))();
    expect(snapshot[0]?.type).toBe('terminal.snapshot');
    expect(JSON.stringify(snapshot)).toContain('AFTER_retained');
    expect(manager.open(path.join(directory, '.'))).toBe(workspace);
  }, 45_000);

  it('interrupts a running process, accepts another command, and keeps terminals isolated', async () => {
    const first = manager.open();
    const secondDirectory = path.join(directory, 'other');
    fs.mkdirSync(secondDirectory);
    const second = manager.open(secondDirectory);
    const id = manager.create(first);
    const otherId = manager.create(second);
    const messages: TerminalServerMessage[] = [];
    manager.attach(first, id, (message) => messages.push(message));
    manager.input(first, id, command(
      "Write-Output ('RUN_' + 'START'); Start-Sleep -Seconds 30; Write-Output ('BAD_' + 'END')",
      "printf 'RUN_%s\\n' START; sleep 30 && printf 'BAD_%s\\n' END"
    ));
    await waitForOutput(messages, 'RUN_START');
    const beforeInterrupt = messages.length;
    manager.input(first, id, '\x03');
    await expect.poll(() => stripVTControlCharacters(messages.slice(beforeInterrupt)
      .filter((message) => message.type === 'terminal.output').map((message) => message.data).join('')).trimEnd(),
    { timeout: 20_000 }).toMatch(/[>$#%]$/);
    manager.input(first, id, command("Write-Output ('CTRL_' + 'OK')", "printf 'CTRL_%s\\n' OK"));
    await waitForOutput(messages, 'CTRL_OK');
    const rawOutput = messages.filter((message) => message.type === 'terminal.output').map((message) => message.data).join('');
    expect(rawOutput).not.toContain('BAD_END');
    expect(() => manager.input(second, id, 'test')).toThrow(/workspace/);
    manager.close(first, id);
    expect(manager.list(first)).toHaveLength(0);
    expect(manager.list(second)[0]?.id).toBe(otherId);
  }, 45_000);

  it('reaps a descendant process after explicitly closing the terminal', async () => {
    const workspace = manager.open();
    const id = manager.create(workspace);
    const messages: TerminalServerMessage[] = [];
    manager.attach(workspace, id, message => messages.push(message));
    manager.input(workspace, id, command(
      "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60') -PassThru; Write-Output ('CHILD_PID=' + $child.Id)",
      "sleep 60 >/dev/null 2>&1 & printf 'CHILD_PID=%s\\n' \"$!\""
    ));
    await expect.poll(() => {
      const output = stripVTControlCharacters(messages.filter(message => message.type === 'terminal.output')
        .map(message => message.data).join(''));
      return /CHILD_PID=(\d+)/.exec(output)?.[1];
    }, { timeout: 20_000, interval: 50 }).toMatch(/\d+/);
    const output = stripVTControlCharacters(messages.filter(message => message.type === 'terminal.output')
      .map(message => message.data).join(''));
    const pid = Number(/CHILD_PID=(\d+)/.exec(output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(processAlive(pid)).toBe(true);
    manager.close(workspace, id);
    await expect.poll(() => processAlive(pid), { timeout: 20_000, interval: 100 }).toBe(false);
  }, 30_000);

  it('restores ANSI screen content at the saved size and reports exit status', async () => {
    const workspace = manager.open();
    const id = manager.create(workspace);
    const messages: TerminalServerMessage[] = [];
    manager.attach(workspace, id, (message) => messages.push(message));
    manager.resize(workspace, id, 100, 30);
    expect(messages).toContainEqual({ type: 'terminal.resized', sessionId: id, cols: 100, rows: 30 });
    manager.input(workspace, id, command(
      "Write-Output (([char]27) + '[31m' + 'ANSI_' + 'RED' + ([char]27) + '[0m')",
      "printf '\\033[31mANSI_%s\\033[0m\\n' RED"
    ));
    await waitForOutput(messages, 'ANSI_RED');
    const snapshots: TerminalServerMessage[] = [];
    manager.attach(workspace, id, (message) => snapshots.push(message))();
    const snapshot = snapshots[0];
    expect(snapshot).toMatchObject({ type: 'terminal.snapshot', cols: 100, rows: 30 });
    expect(JSON.stringify(snapshot)).toContain('ANSI_RED');
    manager.input(workspace, id, 'exit 7\r');
    await expect.poll(() => manager.list(workspace)[0]?.exitCode, { timeout: 20_000 }).toBe(7);
    expect(() => manager.input(workspace, id, 'echo test\r')).toThrow(/exited/);
    expect(() => manager.resize(workspace, id, -1, 24)).toThrow(/dimensions/);
  }, 45_000);

  it('uses the login shell on macOS and rejects nonexistent working directories', () => {
    expect(terminalShell('darwin', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(() => manager.open(path.join(directory, 'missing'))).toThrow();
  });

  it('tracks successful shell directory changes, preserves them across attach, and isolates tabs', async () => {
    const workspace = manager.open();
    const id = manager.create(workspace);
    const otherId = manager.create(workspace);
    const destination = path.join(directory, 'space # \u6587\u6863');
    fs.mkdirSync(destination);
    const messages: TerminalServerMessage[] = [];
    const detach = manager.attach(workspace, id, message => messages.push(message));
    await expect.poll(() => manager.list(workspace).find(info => info.id === id)?.cwdStatus,
      { timeout: 20_000 }).toBe('reported');
    manager.input(workspace, id, command(
      `Set-Location -LiteralPath '${destination.replace(/'/g, "''")}'`,
      `cd '${destination.replace(/'/g, "'\\''")}'`
    ));
    await expect.poll(() => {
      const reported = manager.list(workspace).find(info => info.id === id)?.cwd;
      return reported && fs.realpathSync.native(reported);
    }, { timeout: 20_000 }).toBe(fs.realpathSync.native(destination));
    const reportedCwd = manager.list(workspace).find(info => info.id === id)!.cwd;
    expect(manager.list(workspace).find(info => info.id === otherId)?.cwd).toBe(workspace.cwd);
    detach();
    manager.attach(workspace, id, message => messages.push(message));
    expect(manager.list(workspace).find(info => info.id === id)).toMatchObject({
      cwd: reportedCwd, initialCwd: workspace.cwd, cwdStatus: 'reported'
    });
    manager.input(workspace, id, command(
      "Set-Location -LiteralPath 'missing-child'",
      "cd 'missing-child'"
    ));
    manager.input(workspace, id, command("Write-Output ('FAILED_' + 'CD_DONE')", "printf 'FAILED_%s\\n' CD_DONE"));
    await waitForOutput(messages, 'FAILED_CD_DONE');
    expect(manager.list(workspace).find(info => info.id === id)?.cwd).toBe(reportedCwd);
    if (process.platform === 'win32') {
      manager.input(workspace, id, "Set-Location Env:\\\r");
      await expect.poll(() => manager.list(workspace).find(info => info.id === id)?.cwdStatus,
        { timeout: 20_000 }).toBe('unavailable');
      manager.input(workspace, id, `Set-Location -LiteralPath '${directory.replace(/'/g, "''")}'\r`);
      await expect.poll(() => manager.list(workspace).find(info => info.id === id)?.cwdStatus,
        { timeout: 20_000 }).toBe('reported');
    }
  }, 45_000);
});
