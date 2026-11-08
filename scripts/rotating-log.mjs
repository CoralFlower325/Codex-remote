import fs from 'node:fs';

export function appendBoundedLog(file, data, { maxBytes = 5 * 1024 * 1024, backups = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(backups) || backups < 1 || backups > 10) {
    throw new Error('Invalid log retention settings.');
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let offset = 0; offset < bytes.length;) {
    let size = 0;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Log target must be a regular file.');
      size = info.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size >= maxBytes) {
      fs.rmSync(`${file}.${backups}`, { force: true });
      for (let index = backups - 1; index >= 1; index--) {
        try { fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      fs.renameSync(file, `${file}.1`);
      size = 0;
    }
    const end = Math.min(bytes.length, offset + maxBytes - size);
    // No descriptor survives a write, so rotation works with Windows handles.
    fs.appendFileSync(file, bytes.subarray(offset, end), { mode: 0o600 });
    offset = end;
  }
}

export function boundedLogWriter(file, options) {
  let dropped = 0;
  return data => {
    try {
      if (dropped) appendBoundedLog(file, `[logging recovered; ${dropped} writes were dropped]\n`, options);
      appendBoundedLog(file, data, options);
      dropped = 0;
      return true;
    } catch { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); return false; }
  };
}
