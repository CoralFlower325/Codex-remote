import path from 'node:path';
import os from 'node:os';
import { installation, commandEnvironment } from './controller.mjs';
import { run } from './process.mjs';

export async function discoverInstallations({ platform = process.platform, home = os.homedir(),
  nearby = [], execute = run, inspect = installation } = {}) {
  let services = [];
  try {
    const options = { env: commandEnvironment(), timeout: 5000 };
    if (platform === 'win32') {
      const text = await execute('powershell.exe', ['-NoProfile', '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
        '$task = Get-ScheduledTask -TaskName CodexRemote -ErrorAction SilentlyContinue; ' +
        'ConvertTo-Json -InputObject @($task.Actions | ForEach-Object { $_.WorkingDirectory }) -Compress'], options);
      const roots = JSON.parse(text);
      if (Array.isArray(roots)) services = roots;
    } else if (platform === 'darwin') {
      services = [await execute('/usr/libexec/PlistBuddy',
        ['-c', 'Print :WorkingDirectory', path.join(home, 'Library/LaunchAgents/com.codex.remote.plist')], options)];
    }
  } catch { /* Missing or unreadable service registrations do not block discovery. */ }
  const names = ['codex-remote', 'Codex-remote', 'Codex-remote-public'];
  const common = ['', 'Desktop', 'Documents', 'Downloads', 'Projects', 'Developer', '.codex']
    .flatMap((directory) => names
      .map((name) => path.join(home, directory, name)));
  const candidates = [...services.map((root) => ({ root, source: 'service' })),
    ...nearby.filter((root) => typeof root === 'string' && root).flatMap((root) =>
      [root, ...names.map((name) => path.join(root, name))].map((directory) => ({ root: directory, source: 'nearby' }))),
    ...common.map((root) => ({ root, source: 'common' }))];
  const found = new Map();
  const visited = new Set();
  for (const candidate of candidates) {
    if (typeof candidate.root !== 'string' || !candidate.root.trim()) continue;
    const directory = candidate.root.trim();
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      const info = await inspect(directory);
      const canonical = platform === 'win32' ? info.root.toLowerCase() : info.root;
      if (!found.has(canonical)) found.set(canonical, { root: info.root, version: info.version, source: candidate.source });
    } catch { /* Only complete, configured installations are offered. */ }
  }
  return [...found.values()];
}

export function preferredInstallation(found, currentRoot = '') {
  const current = found.find((candidate) => candidate.root === currentRoot);
  if (current) return current;
  const owned = found.filter((candidate) => candidate.source === 'service');
  return owned.length === 1 ? owned[0] : found.length === 1 ? found[0] : null;
}
