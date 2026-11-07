import { watchFile, unwatchFile, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { normalizePreviewPath } from '../shared/file-preview.js';

export function previewRevision(info: Stats): string {
  return createHash('sha256').update(
    `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  ).digest('hex').slice(0, 24);
}

export function previewWatchRouter(authorized: (req: Request) => boolean): Router {
  const router = Router();
  let connections = 0;
  router.get('/watch', (req, res) => {
    const requested = normalizePreviewPath(typeof req.query.path === 'string' ? req.query.path : '');
    if (!requested || !path.isAbsolute(requested)) {
      res.status(400).json({ error: 'An absolute file path is required.' }); return;
    }
    if (connections >= 128) { res.sendStatus(429); return; }
    connections++;
    const filePath = path.resolve(requested);
    let closed = false, checking = false, trailing = false;
    let previous = '';
    const valid = () => {
      try { return authorized(req); } catch { return false; }
    };
    const close = () => {
      if (closed) return;
      closed = true; connections--;
      unwatchFile(filePath, changed);
      clearInterval(heartbeat);
      res.end();
    };
    const check = async () => {
      if (closed) return;
      if (!valid()) { close(); return; }
      if (checking) { trailing = true; return; }
      checking = true;
      try {
        const info = await fs.stat(filePath).catch(() => null);
        const revision = info?.isFile() ? previewRevision(info) : 'missing';
        if (!closed && valid() && revision !== previous) {
          previous = revision;
          // Content stays behind the ordinary authenticated, no-store read.
          if (!res.write(`data: ${JSON.stringify({ revision })}\n\n`)) close();
        }
      } finally {
        checking = false;
        if (trailing && !closed) { trailing = false; void check(); }
      }
    };
    const changed = () => { void check(); };
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    const heartbeat = setInterval(() => {
      if (!valid()) { close(); return; }
      if (!res.write(': preview\n\n')) close();
    }, 5000).unref();
    res.on('close', close);
    // Stat watching matches Desktop's open-file subscription and survives
    // editors replacing a file by rename, including delete/recreate saves.
    try { watchFile(filePath, { interval: 250, persistent: false }, changed); }
    catch { close(); return; }
    void check();
  });
  return router;
}
