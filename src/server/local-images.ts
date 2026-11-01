import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);

export class LocalImages {
  private entries: Record<string, string> = {};
  private ready: Promise<void>;
  private pending = new Map<string, Promise<string | null>>();
  private save = Promise.resolve();
  private unavailable = false;

  constructor(private readonly directory: string) {
    this.ready = fs.readFile(path.join(directory, 'index.json'), 'utf8')
      .then(text => {
        const entries: unknown = JSON.parse(text);
        if (!entries || typeof entries !== 'object' || Array.isArray(entries) ||
          !Object.values(entries).every(value => typeof value === 'string' &&
            /^[\w-]+\.(?:png|jpg|jpeg|webp|gif|bmp|avif)$/i.test(value))) throw new Error('Invalid image index');
        this.entries = entries as Record<string, string>;
      })
      .catch(error => {
        if (error.code === 'ENOENT') return;
        this.unavailable = true;
        console.warn('[images] Attachment index unavailable; existing data was preserved.');
      });
  }

  async resolve(source: string): Promise<string | null> {
    await this.ready;
    const absolute = path.resolve(source);
    if (!imageExtensions.has(path.extname(absolute).toLowerCase())) return null;
    if (this.unavailable) {
      if ((await fs.stat(absolute).catch(() => null))?.isFile()) return absolute;
      throw new Error('附件索引暂不可用，请在主机检查并恢复索引后重启 Remote。');
    }
    const existing = this.pending.get(absolute);
    if (existing) return existing;
    const request = this.retain(absolute).finally(() => this.pending.delete(absolute));
    this.pending.set(absolute, request);
    return request;
  }

  private async retain(source: string): Promise<string | null> {
    const retained = this.entries[source];
    const info = await fs.stat(source).catch(() => null);
    if (retained) return info?.isFile() ? source : path.join(this.directory, retained);
    if (!info?.isFile()) return null;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}${path.extname(source).toLowerCase()}`;
    const destination = path.join(this.directory, name);
    await fs.copyFile(source, destination);
    this.entries[source] = name;
    const write = this.save.catch(() => {}).then(async () => {
      const temporary = path.join(this.directory, 'index.next');
      await fs.writeFile(temporary, JSON.stringify(this.entries), { mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, 'index.json'));
    });
    this.save = write;
    await write;
    return destination;
  }

  async remember(item: unknown): Promise<void> {
    const message = item as { type?: string; content?: Array<{ type: string; path?: string }> } | null;
    if (message?.type !== 'userMessage' || !Array.isArray(message.content)) return;
    await Promise.all(message.content.filter(part => part.type === 'localImage' && part.path)
      .map(part => this.resolve(part.path!)));
  }
}
