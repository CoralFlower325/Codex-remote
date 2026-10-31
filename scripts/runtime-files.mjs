import path from 'node:path';

// Filter staging only. Keep the installed tree and separate debug evidence intact.
export function runtimeFile(relative, platform = process.platform, arch = process.arch) {
  const parts = relative.split(/[\\/]/);
  if (parts.includes('.bin') || parts.includes('.vitest-cache')) return false;
  if (path.extname(relative).toLowerCase() === '.pdb') return false;
  const prebuild = parts.lastIndexOf('prebuilds');
  if (prebuild !== -1 && parts[prebuild + 1] &&
    /^(?:win32|darwin|linux|android|freebsd)-/.test(parts[prebuild + 1])) {
    return parts[prebuild + 1] === `${platform}-${arch}`;
  }
  return true;
}
