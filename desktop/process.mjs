import { spawn } from 'node:child_process';

export function run(file, args, { cwd, timeout = 30_000, env = process.env, onLine, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32' });
    let output = '';
    const chunks = [];
    let size = 0;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      // Only terminate the command tree created by this operation.
      if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }, timeout);
    for (const stream of [child.stdout, child.stderr]) {
      if (!raw || stream === child.stderr) stream.setEncoding('utf8');
      stream.on('data', (text) => {
        if (raw && stream === child.stdout) {
          size += text.length;
          if (size > 32 * 1024 * 1024) { child.kill(); return; }
          chunks.push(text);
          return;
        }
        output = (output + text).slice(-128_000);
        onLine?.(text);
      });
    }
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error(`Command timed out: ${file}`));
      else if (code !== 0 || size > 32 * 1024 * 1024) reject(new Error(output.trim() || `${file} exited with ${code}`));
      else resolve(raw ? Buffer.concat(chunks) : output.trim());
    });
  });
}
