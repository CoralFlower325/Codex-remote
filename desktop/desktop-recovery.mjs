import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';

const portPattern = /(?:^|\s)--remote-debugging-port(?:=|\s+)(\d{1,5})(?=\s|$)/i;

function normalized(value) {
  return path.win32.normalize(String(value).replace(/^\\\\\?\\/, '')).toLowerCase();
}

function trustedWindowsExecutable(executable, environment) {
  const value = normalized(executable);
  if (!['chatgpt.exe', 'codex.exe'].includes(path.win32.basename(value))) return false;
  const roots = [environment.ProgramFiles, environment['ProgramFiles(x86)']]
    .filter(Boolean).flatMap(root => [
      path.win32.join(root, 'WindowsApps', 'OpenAI.Codex_'),
      path.win32.join(root, 'WindowsApps', 'OpenAI.ChatGPT_'),
      path.win32.join(root, 'OpenAI', 'Codex') + '\\',
      path.win32.join(root, 'OpenAI', 'ChatGPT') + '\\'
    ]).map(normalized);
  if (environment.LOCALAPPDATA) {
    const programs = path.win32.join(environment.LOCALAPPDATA, 'Programs');
    roots.push(
      path.win32.join(programs, 'Codex') + '\\',
      path.win32.join(programs, 'ChatGPT') + '\\',
      path.win32.join(programs, 'OpenAI', 'Codex') + '\\',
      path.win32.join(programs, 'OpenAI', 'ChatGPT') + '\\'
    );
  }
  return roots.some(root => value.startsWith(normalized(root)));
}

function desktopProcess(record, platform) {
  const pid = Number(record.ProcessId ?? record.pid);
  const executable = String(record.ExecutablePath ?? record.executable ?? '').trim();
  const commandLine = String(record.CommandLine ?? record.command ?? '').trim();
  if (!Number.isInteger(pid) || pid <= 0 || !executable || !commandLine ||
    /(?:^|\s)--type(?:=|\s+)/i.test(commandLine)) return null;
  const match = portPattern.exec(commandLine);
  const debugPort = match ? Number(match[1]) : 0;
  return { pid, executable, commandLine,
    debugPort: Number.isInteger(debugPort) && debugPort > 0 && debugPort <= 65535 ? debugPort : 0,
    platform };
}

export async function listDesktopProcesses({ platform = process.platform, environment = process.env,
  execute = run } = {}) {
  if (platform === 'win32') {
    const text = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';$items=@(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" " +
      "| Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } " +
      '| Select-Object ProcessId,ExecutablePath,CommandLine);ConvertTo-Json -InputObject $items -Depth 3 -Compress'],
    { timeout: 5000 });
    const records = JSON.parse(text || '[]');
    return (Array.isArray(records) ? records : [records]).flatMap(record => {
      if (!trustedWindowsExecutable(record.ExecutablePath, environment)) return [];
      const process = desktopProcess(record, platform);
      return process ? [process] : [];
    });
  }
  if (platform === 'darwin') {
    const output = await execute('/bin/ps', ['-axo', 'pid=,command='], { timeout: 5000 });
    return output.split(/\r?\n/).flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) return [];
      const executable = ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
        '/Applications/Codex.app/Contents/MacOS/Codex',
        path.posix.join(environment.HOME || '', 'Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
        path.posix.join(environment.HOME || '', 'Applications/Codex.app/Contents/MacOS/Codex')]
        .find(candidate => match[2] === candidate || match[2].startsWith(`${candidate} `));
      if (!executable) return [];
      const process = desktopProcess({ pid: match[1], executable,
        command: match[2] }, platform);
      return process ? [process] : [];
    });
  }
  return [];
}

function restartScript() {
  return fileURLToPath(new URL('./restart-desktop-windows.ps1', import.meta.url))
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

async function launchDetached(process, executable, args, platform, spawnProcess) {
  if (platform === 'darwin') {
    const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(executable)?.[1];
    if (!bundle) throw new Error('无法定位 Codex Desktop 应用包。');
    await run('/usr/bin/open', ['-na', bundle, '--args', ...args], { timeout: 15000 });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function restartDesktopForRemote(candidate, { port, environment = process.env,
  execute = run, spawnProcess = spawn, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!candidate || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Desktop 恢复参数无效。');
  }
  const platform = candidate.platform ?? process.platform;
  if (platform === 'win32') {
    if (!trustedWindowsExecutable(candidate.executable, environment)) {
      throw new Error('Desktop 可执行文件不在受信任的安装路径。');
    }
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', restartScript(), '-ProcessId', String(candidate.pid), '-ExecutablePath', candidate.executable],
    { timeout: 20000 });
  } else if (platform === 'darwin') {
    await execute('/bin/kill', ['-TERM', String(candidate.pid)], { timeout: 5000 });
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await execute('/bin/ps', ['-p', String(candidate.pid)], { timeout: 2000 });
        await wait(250);
      } catch { break; }
    }
    try { await execute('/bin/kill', ['-KILL', String(candidate.pid)], { timeout: 5000 }); }
    catch { /* The process reached its normal exit before the force-kill fallback. */ }
  } else {
    throw new Error('当前平台不支持自动恢复 Desktop 调试连接。');
  }
  await launchDetached(candidate, candidate.executable,
    [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`], platform, spawnProcess);
  return { pid: candidate.pid, executable: candidate.executable, port };
}
