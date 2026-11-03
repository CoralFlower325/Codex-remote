import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { TerminalClientMessage, TerminalServerMessage } from '../shared/terminal.js';
import { TerminalManager } from './terminal-manager.js';
import { handleTerminalSocket } from './terminal-socket.js';

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: TerminalServerMessage[] = [];
  closeCode = 0;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(message: TerminalClientMessage) { this.emit('message', Buffer.from(JSON.stringify(message))); }
  close(code = 1000) { this.closeCode = code; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

describe('terminal socket lifecycle', () => {
  const managers: TerminalManager[] = [];
  const directories: string[] = [];
  function setup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-socket-'));
    directories.push(directory);
    const manager = new TerminalManager(directory);
    managers.push(manager);
    const socket = new Socket();
    handleTerminalSocket(socket as unknown as WebSocket, manager);
    return { directory, manager, socket };
  }

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const directory of directories.splice(0)) {
      await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('keeps sessions when the connection closes and restores them without spawning another shell', () => {
    const { manager, socket } = setup();
    socket.receive({ type: 'terminal.open' });
    const first = socket.sent.find((message) => message.type === 'terminal.state');
    expect(first?.type).toBe('terminal.state');
    socket.close();
    const next = new Socket();
    handleTerminalSocket(next as unknown as WebSocket, manager);
    next.receive({ type: 'terminal.open' });
    expect(next.sent.find((message) => message.type === 'terminal.state')).toEqual(first);
    expect(manager.list(manager.open())).toHaveLength(1);
    expect(manager.open().listeners.size).toBe(1);
    next.close();
    expect(manager.open().listeners.size).toBe(0);
  });

  it('creates, switches, closes, and clears the final tab without creating a replacement', () => {
    const { manager, socket } = setup();
    socket.receive({ type: 'terminal.open' });
    const firstId = manager.list(manager.open())[0]!.id;
    socket.receive({ type: 'terminal.create' });
    const secondId = manager.list(manager.open())[1]!.id;
    socket.receive({ type: 'terminal.attach', sessionId: firstId });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.snapshot', sessionId: firstId });
    socket.receive({ type: 'terminal.close', sessionId: firstId });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.snapshot', sessionId: secondId });
    socket.receive({ type: 'terminal.close', sessionId: secondId });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.state', activeSessionId: null, sessions: [] });
    socket.close();
  });

  it('rejects input before attach, foreign sessions, malformed input, and invalid dimensions', () => {
    const { manager, directory, socket } = setup();
    socket.receive({ type: 'terminal.input', sessionId: 'none', data: 'text' });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.error' });
    socket.receive({ type: 'terminal.open' });
    const id = manager.list(manager.open())[0]!.id;
    const otherDirectory = path.join(directory, 'other');
    fs.mkdirSync(otherDirectory);
    const other = manager.open(otherDirectory);
    const otherId = manager.create(other);
    socket.receive({ type: 'terminal.attach', sessionId: otherId });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.error', message: expect.stringContaining('workspace') });
    socket.receive({ type: 'terminal.input', sessionId: id, data: 'x'.repeat(65 * 1024) });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.error', message: expect.stringContaining('large') });
    socket.receive({ type: 'terminal.resize', sessionId: id, cols: 0, rows: 24 });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.error', message: expect.stringContaining('dimensions') });
    socket.receive({ type: 'terminal.close', sessionId: otherId });
    expect(manager.list(other)).toHaveLength(1);
    socket.close();
  });

  it('reports a missing task directory fallback and does not silently replace invalid explicit directories', () => {
    const { socket, directory } = setup();
    socket.receive({ type: 'terminal.open' });
    expect(socket.sent.find(message => message.type === 'terminal.state')).toMatchObject({ cwdFallback: true });
    socket.receive({ type: 'terminal.open', cwd: directory });
    expect(socket.sent.filter(message => message.type === 'terminal.state').at(-1)).toMatchObject({ cwdFallback: false });
    socket.receive({ type: 'terminal.open', cwd: path.join(directory, 'missing') });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.error' });
    socket.receive({ type: 'terminal.open', cwd: '' });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'terminal.error' });
    socket.close();
  });

  it('starts at an explicitly selected root without resetting the old shell or duplicating reconnects', async () => {
    const { socket, manager, directory } = setup();
    socket.receive({ type: 'terminal.open', cwd: directory });
    const workspace = manager.open(directory);
    const original = manager.list(workspace)[0]!;
    await expect.poll(() => manager.list(workspace)[0]?.cwdStatus, { timeout: 20_000 }).toBe('reported');
    manager.input(workspace, original.id, process.platform === 'win32'
      ? "Set-Location ..\r" : "cd ..\r");
    await expect.poll(() => manager.list(workspace)[0]?.cwd, { timeout: 20_000 }).toBe(path.dirname(workspace.cwd));
    socket.receive({ type: 'terminal.open', cwd: directory, startAtCwd: true });
    const selected = manager.list(workspace).at(-1)!;
    expect(manager.list(workspace)).toHaveLength(2);
    expect(selected.id).not.toBe(original.id);
    expect(selected.initialCwd).toBe(workspace.cwd);
    expect(manager.list(workspace)[0]?.cwd).toBe(path.dirname(workspace.cwd));
    socket.receive({ type: 'terminal.open', cwd: directory, startAtCwd: true });
    expect(manager.list(workspace)).toHaveLength(2);
    expect(socket.sent.filter(message => message.type === 'terminal.state').at(-1))
      .toMatchObject({ activeSessionId: selected.id });
    socket.close();
  }, 30_000);

  it('disconnects a client that cannot render its output so reconnect can restore a bounded snapshot', async () => {
    const { manager, socket } = setup();
    socket.receive({ type: 'terminal.open' });
    const id = manager.list(manager.open())[0]!.id;
    socket.receive({
      type: 'terminal.input', sessionId: id,
      data: process.platform === 'win32'
        ? "Write-Output ('X' * 600000)\r"
        : "printf '%600000s\\n' '' | tr ' ' X\r"
    });
    await expect.poll(() => socket.closeCode, { timeout: 20_000 }).toBe(1013);
    expect(manager.list(manager.open())[0]?.id).toBe(id);
  }, 25_000);
});
