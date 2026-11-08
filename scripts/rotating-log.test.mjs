import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { appendBoundedLog } from './rotating-log.mjs';

it('bounds continuous output and retains the newest bytes across repeated rotations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-log-'));
  try {
    const file = path.join(root, 'server.log');
    appendBoundedLog(file, Buffer.from('abcdefghijklmnopqrstu'), { maxBytes: 4, backups: 2 });
    expect(fs.readdirSync(root).sort()).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    expect(fs.readFileSync(file, 'utf8')).toBe('u');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('qrst');
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe('mnop');
    appendBoundedLog(file, 'vwx', { maxBytes: 4, backups: 2 });
    expect(fs.readFileSync(file, 'utf8')).toBe('uvwx');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
