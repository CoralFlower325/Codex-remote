import { WebSocket } from 'ws';

import type { TerminalClientMessage, TerminalServerMessage } from '../shared/terminal.js';
import { TerminalManager, type TerminalWorkspace } from './terminal-manager.js';

export function handleTerminalSocket(socket: WebSocket, manager: TerminalManager, authorized = () => true): void {
  let workspace: TerminalWorkspace | null = null;
  let activeId: string | null = null;
  let detach: (() => void) | undefined;
  let unacknowledged = 0;

  function send(message: TerminalServerMessage) {
    if (!authorized()) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (message.type === 'terminal.output') unacknowledged += message.data.length;
    // A stalled phone can recover its screen from a snapshot without queuing unlimited output.
    if (unacknowledged > 512 * 1024 || socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close(1013, 'Terminal client is behind');
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function attach(id: string | null) {
    detach?.();
    detach = undefined;
    activeId = id;
    unacknowledged = 0;
    sendState();
    if (workspace && id) detach = manager.attach(workspace, id, send);
  }

  function sendState() {
    if (workspace) send({
      type: 'terminal.state', cwd: workspace.cwd, sessions: manager.list(workspace), activeSessionId: activeId
    });
  }

  function changed() {
    if (workspace && activeId && !workspace.sessions.has(activeId)) attach(workspace.activeSessionId);
    else sendState();
  }

  socket.on('message', (raw) => {
    if (!authorized()) return;
    try {
      const message = JSON.parse(raw.toString()) as TerminalClientMessage;
      if (message.type === 'ping') { send({ type: 'pong', at: new Date().toISOString() }); return; }
      if (message.type === 'terminal.open') {
        if (message.cwd !== undefined && typeof message.cwd !== 'string') throw new Error('Invalid working directory.');
        workspace?.listeners.delete(changed);
        detach?.();
        detach = undefined;
        activeId = null;
        workspace = manager.open(message.cwd);
        if (!workspace.sessions.size) manager.create(workspace);
        workspace.listeners.add(changed);
        attach(workspace.activeSessionId);
        return;
      }
      if (!workspace) throw new Error('Open a workspace terminal first.');
      if (message.type === 'terminal.create') { attach(manager.create(workspace)); return; }
      if (message.type === 'terminal.attach') {
        if (!workspace.sessions.has(message.sessionId)) throw new Error('Terminal does not belong to this workspace.');
        attach(message.sessionId);
        return;
      }
      if (message.type === 'terminal.close') { manager.close(workspace, message.sessionId); return; }
      if (message.type === 'terminal.ack') {
        if (message.sessionId === activeId && Number.isInteger(message.size) && message.size > 0) {
          unacknowledged = Math.max(0, unacknowledged - message.size);
        }
        return;
      }
      if (message.type === 'terminal.input' || message.type === 'terminal.resize') {
        if (!activeId || message.sessionId !== activeId) throw new Error('Terminal is not attached.');
        if (message.type === 'terminal.input') {
          if (typeof message.data !== 'string' || message.data.length > 64 * 1024) throw new Error('Terminal input is too large.');
          manager.input(workspace, activeId, message.data);
        } else manager.resize(workspace, activeId, message.cols, message.rows);
        return;
      }
      throw new Error('Unknown terminal message.');
    } catch (error) {
      send({ type: 'terminal.error', message: error instanceof Error ? error.message : String(error) });
    }
  });
  socket.on('close', () => {
    workspace?.listeners.delete(changed);
    detach?.();
  });
}
