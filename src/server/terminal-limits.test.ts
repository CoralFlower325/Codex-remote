import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalServerMessage } from '../shared/terminal.js';
import { TerminalManager } from './terminal-manager.js';

const pty = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn(() => ({ dispose() {} })),
    resize: vi.fn(), write: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn()
  }))
}));
vi.mock('./terminal-process.js', () => ({ spawnTerminal: pty.spawn }));

const directories: string[] = [];
const managers: TerminalManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function setup(limits = { sessions: 2, perWorkspace: 1, workspaces: 2 }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-limits-'));
  directories.push(directory);
  const manager = new TerminalManager(directory, limits);
  managers.push(manager);
  return { directory, manager };
}

describe('terminal resource and viewer ownership', () => {
  it('rejects new shells at workspace and global caps without killing existing sessions', () => {
    const { directory, manager } = setup();
    const first = manager.open();
    const firstId = manager.create(first);
    expect(() => manager.create(first)).toThrow();
    const otherDirectory = path.join(directory, 'other');
    fs.mkdirSync(otherDirectory);
    const other = manager.open(otherDirectory);
    const otherId = manager.create(other);
    expect(() => manager.create(other)).toThrow();
    expect(manager.list(first)[0]?.id).toBe(firstId);
    expect(manager.list(other)[0]?.id).toBe(otherId);
    manager.close(first, firstId);
    expect(manager.create(first)).toBeTypeOf('string');
  });

  it('prunes only empty detached workspaces and preserves retained shells', () => {
    const { directory, manager } = setup({ sessions: 3, perWorkspace: 2, workspaces: 1 });
    const first = manager.open();
    const id = manager.create(first);
    const otherDirectory = path.join(directory, 'other');
    fs.mkdirSync(otherDirectory);
    expect(() => manager.open(otherDirectory)).toThrow();
    manager.close(first, id);
    const detached = manager.open(otherDirectory);
    expect(detached.cwd).toBe(fs.realpathSync.native(otherDirectory));
  });

  it('uses one viewer geometry and transfers ownership when that viewer detaches', () => {
    const { manager } = setup();
    const workspace = manager.open();
    const id = manager.create(workspace);
    const ownerMessages: TerminalServerMessage[] = [];
    const viewerMessages: TerminalServerMessage[] = [];
    const owner = (message: TerminalServerMessage) => ownerMessages.push(message);
    const viewer = (message: TerminalServerMessage) => viewerMessages.push(message);
    const detach = manager.attach(workspace, id, owner);
    manager.attach(workspace, id, viewer);
    manager.resize(workspace, id, 120, 40, owner);
    manager.resize(workspace, id, 70, 20, viewer);
    expect(viewerMessages.at(-1)).toEqual({ type: 'terminal.resized', sessionId: id, cols: 120, rows: 40 });
    expect(ownerMessages.at(-1)).toEqual({ type: 'terminal.resized', sessionId: id, cols: 120, rows: 40 });
    detach();
    manager.resize(workspace, id, 70, 20, viewer);
    expect(viewerMessages.at(-1)).toEqual({ type: 'terminal.resized', sessionId: id, cols: 70, rows: 20 });
  });
});
