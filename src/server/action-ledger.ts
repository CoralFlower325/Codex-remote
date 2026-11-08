import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

interface RecordEntry { fingerprint: string; state: 'pending' | 'done' | 'failed'; result?: unknown;
  error?: { message: string; code?: number }; }
const uncertain = '操作可能已经执行，但未收到确认。为避免重复执行，已阻止自动重发；请先在 Desktop 核对会话记录。';

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node's file handles.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export class ActionLedger {
  private running = new Map<string, Promise<unknown>>();
  constructor(private directory: string) {}

  async execute(id: string, method: string, params: unknown, dispatch: () => Promise<unknown>): Promise<unknown> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('操作标识无效。');
    const { clientUserMessageId: _messageId, ...body } =
      (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([method, body])).digest('hex');
    const file = path.join(this.directory, `${id}.json`);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let existing: RecordEntry | null = null;
    try { existing = JSON.parse(await fs.readFile(file, 'utf8')) as RecordEntry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(uncertain); }
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('操作标识已用于另一项请求。');
      if (this.running.has(id)) return this.running.get(id)!;
      if (existing.state === 'done') return existing.result;
      if (existing.state === 'failed') throw Object.assign(new Error(existing.error?.message ?? uncertain), existing.error);
      throw new Error(uncertain);
    }
    // Never evict uncertain actions: deleting one would make an old retry executable again.
    if ((await fs.readdir(this.directory)).length >= 10_000) throw new Error('操作记录已达上限，请在本机检查并归档记录。');
    const handle = await fs.open(file, 'wx', 0o600).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error(uncertain);
      throw error;
    });
    try { await handle.writeFile(JSON.stringify({ fingerprint, state: 'pending' })); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(path.dirname(this.directory));
    await syncDirectory(this.directory);
    const operation = (async () => {
      let final: RecordEntry;
      try {
        const result = await dispatch();
        final = { fingerprint, state: 'done', result };
      } catch (error) {
        const native = error as { code?: number; message?: string };
        if (!Number.isInteger(native.code)) throw new Error(uncertain, { cause: error });
        final = { fingerprint, state: 'failed', error: { code: native.code!, message: native.message ?? '操作失败。' } };
      }
      const bytes = JSON.stringify(final);
      if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error(uncertain);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      const output = await fs.open(temporary, 'wx', 0o600);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      await fs.rename(temporary, file);
      await syncDirectory(this.directory);
      if (final.state === 'failed') throw Object.assign(new Error(final.error!.message), final.error);
      return final.result;
    })();
    this.running.set(id, operation);
    try { return await operation; } finally { this.running.delete(id); }
  }
}
