import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

export const officeExtensions = new Set([
  '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp'
]);
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT = 45_000;

export class OfficePreviewError extends Error {
  constructor(message: string, public readonly status = 422) { super(message); }
}

const TEMP_PREFIX = 'codex-remote-preview-';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function cleanupStalePreviewDirectories(root = os.tmpdir(), now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const candidate = path.join(root, entry.name);
    try {
      const info = await fs.stat(candidate);
      if (now - info.mtimeMs < STALE_AFTER_MS) continue;
      await fs.rm(candidate, { recursive: true, force: true, maxRetries: 2 });
      removed++;
    } catch { /* Another conversion or cleanup may already own it. */ }
  }
  return removed;
}

export async function findOfficeBinary(): Promise<string | null> {
  if (process.env.LIBREOFFICE_PATH?.trim()) return process.env.LIBREOFFICE_PATH.trim();
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
      .map(root => path.join(root!, 'LibreOffice', 'program', 'soffice.com'))
    : ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/libreoffice',
      '/usr/bin/soffice', '/usr/local/bin/libreoffice', '/opt/homebrew/bin/soffice'];
  for (const candidate of candidates) {
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}

// A fresh profile cannot inherit trusted macro locations or the operator's
// existing Office session. Active content and automatic link updates stay off.
const profile = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting">
<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
<prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
<prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop>
<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
</item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update">
<prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
</item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update">
<prop oor:name="Link" oor:op="fuse"><value>1</value></prop>
</item>
</oor:items>`;

export function runOffice(binary: string, args: string[], environment: NodeJS.ProcessEnv,
  timeout = TIMEOUT): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore', env: environment
    });
    let timedOut = false;
    let termination = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Target only our fresh-profile launcher and its descendants.
        termination = new Promise<void>(done => {
          execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { child.kill(); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new OfficePreviewError('主机 LibreOffice 无法启动，请检查安装或 LIBREOFFICE_PATH，或下载原文件。', 503));
    });
    child.once('close', code => {
      clearTimeout(timer);
      void termination.then(() => {
        if (timedOut) reject(new OfficePreviewError('文档预览超时，请下载原文件或稍后重试。'));
        else if (code !== 0) reject(new OfficePreviewError('无法渲染此文档，请确认文件未损坏、未加密，且主机 LibreOffice 可用。'));
        else resolve();
      });
    });
  });
}

export async function convert(source: string, extension: string): Promise<Buffer> {
  void cleanupStalePreviewDirectories();
  if (['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'].includes(extension)) {
    const file = await fs.open(source, 'r');
    try {
      const signature = Buffer.alloc(4);
      await file.read(signature, 0, 4, 0);
      if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new OfficePreviewError('文档格式与扩展名不符或文件已损坏，请下载原文件检查。');
      }
    } finally { await file.close(); }
  }
  const binary = await findOfficeBinary();
  if (!binary) throw new OfficePreviewError(
    '主机尚未安装 LibreOffice，无法预览此文档。请在主机安装后重试，或下载原文件。', 503);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-preview-'));
  try {
    await fs.chmod(directory, 0o700);
    const user = path.join(directory, 'profile', 'user');
    await fs.mkdir(user, { recursive: true });
    await fs.writeFile(path.join(user, 'registrymodifications.xcu'), profile, { mode: 0o600 });
    const input = path.join(directory, `document${extension}`);
    await fs.copyFile(source, input);
    if ((await fs.stat(input)).size > MAX_BYTES) throw new OfficePreviewError('文档超过 32 MiB，请下载原文件。', 413);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|WINDIR|LANG|LC_.*|FONTCONFIG_.*)$/i.test(key)));
    await runOffice(binary, [
        `-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`,
        '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore',
        '--convert-to', 'pdf', '--outdir', directory, input
      ], environment);
    const output = path.join(directory, 'document.pdf');
    const info = await fs.stat(output).catch(() => null);
    if (!info?.isFile() || info.size > MAX_BYTES) throw new OfficePreviewError(
      '无法生成文档预览，文件可能已加密、损坏或预览过大。请下载原文件。');
    const pdf = await fs.readFile(output);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new OfficePreviewError('文档预览生成失败，请下载原文件。');
    return pdf;
  } finally {
    // Only this invocation's freshly created directory is ever removed.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
      console.warn('[preview] Could not remove temporary document conversion files.');
    });
  }
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    void new Promise<void>(resolve => {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    child.kill();
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function isolatedWorkerCommand(): { command: string; args: string[] } {
  const source = fileURLToPath(new URL('./office-preview-worker.ts', import.meta.url));
  const compiled = source.replace(/\.ts$/, '.js');
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  if (existsSync(tsx)) return { command: process.execPath, args: [tsx, source] };
  return { command: process.execPath, args: [compiled] };
}

export function runIsolatedConversion(source: string, extension: string, timeout = TIMEOUT): Promise<Buffer> {
  const { command, args } = isolatedWorkerCommand();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|WINDIR|LANG|LC_.*|FONTCONFIG_.*)$/i.test(key)));
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let settled = false;
    let timedOut = false;
    let stderr = '';
    let response: { pdf?: string; error?: string; status?: number } | null = null;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeout);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk}`.slice(-16 * 1024);
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as { pdf?: unknown; error?: unknown; status?: unknown };
      if (value.pdf !== undefined && typeof value.pdf !== 'string') return;
      response = {
        ...(typeof value.pdf === 'string' ? { pdf: value.pdf } : {}),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...(typeof value.status === 'number' ? { status: value.status } : {})
      };
    });
    child.once('error', error => {
      clearTimeout(timer);
      finish(new OfficePreviewError(`文档预览隔离进程无法启动：${error.message}`, 503));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        finish(new OfficePreviewError('文档预览超时，请下载原文件或稍后重试。'));
        return;
      }
      if (code !== 0 || !response) {
        finish(new OfficePreviewError(
          response?.error || (stderr.trim() ? '文档预览隔离进程异常退出，请下载原文件。' : '文档预览隔离进程异常退出。'),
          response?.status ?? 422));
        return;
      }
      if (response.error) {
        finish(new OfficePreviewError(response.error, response.status ?? 422));
        return;
      }
      const pdf = Buffer.from(response.pdf ?? '', 'base64');
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        finish(new OfficePreviewError('文档预览生成失败，请下载原文件。'));
        return;
      }
      finish(undefined, pdf);
    });
    child.send({ source, extension });
  });
}

export class OfficePreviews {
  private pending = new Map<string, Promise<Buffer>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly render = runIsolatedConversion) {}

  async read(requestedPath: string): Promise<Buffer> {
    if (!path.isAbsolute(requestedPath) || !officeExtensions.has(path.extname(requestedPath).toLowerCase())) {
      throw new OfficePreviewError('不支持此文档格式。', 400);
    }
    const source = await fs.realpath(requestedPath);
    const info = await fs.stat(source);
    if (!info.isFile()) throw new OfficePreviewError('文档不存在。', 404);
    if (info.size > MAX_BYTES) throw new OfficePreviewError('文档超过 32 MiB，请下载原文件。', 413);
    const key = JSON.stringify([source, info.size, info.mtimeMs, info.ctimeMs]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 3) throw new OfficePreviewError('文档预览繁忙，请稍后重试。', 429);
    // Serialize conversions; identical readers share only the in-flight result.
    // Finished bytes are not persisted or retained as a private-content cache.
    const work = this.tail.then(() => this.render(source, path.extname(requestedPath).toLowerCase()))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    this.tail = work.catch(() => {});
    return work;
  }
}
