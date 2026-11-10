import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Router, raw, type RequestHandler } from 'express';
import { documentExtension, isSupportedDocumentName } from '../shared/document-formats.js';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_STORAGE_BYTES = 1024 * 1024 * 1024;
const MAX_DOCUMENT_COUNT = 2048;
const UNUSED_LIFETIME_MS = 24 * 60 * 60 * 1000;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredDocument {
  id: string; name: string; size: number; path: string;
  digest: string; createdAt: number; retained: boolean;
}
class AttachmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function safeName(value: string): string {
  const name = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '');
  const extension = documentExtension(name);
  if (!isSupportedDocumentName(name) || name.length > 180 || Buffer.byteLength(name, 'utf8') > 240 ||
      !name.slice(0, -extension.length).trim()) {
    throw new AttachmentError('请选择受支持的图片、PDF、Office、文本或代码文件；文件名过长时请缩短后重试。');
  }
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

export class DocumentAttachments {
  private operations: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string, private readonly storageLimit = MAX_STORAGE_BYTES,
    private readonly now = Date.now) { this.directory = path.resolve(directory); }

  private async rootReady(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AttachmentError('附件存储目录无效。', 409);
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operations.then(action);
    this.operations = result.catch(() => {});
    return result;
  }
  private folder(id: string): string {
    if (!validId.test(id)) throw new AttachmentError('附件标识无效。');
    return path.join(this.directory, id.toLowerCase());
  }
  private async metadata(id: string): Promise<StoredDocument | null> {
    const folder = this.folder(id);
    const stat = await fs.lstat(folder).catch(() => null);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AttachmentError('附件存储目录无效。', 409);
    const record = await fs.lstat(path.join(folder, 'metadata.json')).catch(() => null);
    if (record && (!record.isFile() || record.isSymbolicLink())) throw new AttachmentError('附件存储记录无效。', 409);
    const source = await fs.readFile(path.join(folder, 'metadata.json'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (source === null) return null;
    const result = JSON.parse(source) as StoredDocument;
    if (result.id !== id.toLowerCase() || result.name !== safeName(result.name) ||
      result.path !== path.resolve(folder, result.name)) throw new AttachmentError('附件存储记录无效。', 409);
    return result;
  }
  private async sweep(): Promise<{ bytes: number; count: number }> {
    await this.rootReady();
    let bytes = 0, count = 0;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId.test(entry.name)) continue;
      const folder = this.folder(entry.name);
      const metadata = await this.metadata(entry.name).catch(() => undefined);
      const stat = await fs.stat(folder);
      if (metadata !== undefined && !metadata?.retained &&
        this.now() - (metadata?.createdAt ?? stat.mtimeMs) > UNUSED_LIFETIME_MS) {
        await fs.rm(folder, { recursive: true, force: true });
        continue;
      }
      count++;
      for (const file of await fs.readdir(folder, { withFileTypes: true })) {
        if (file.isFile()) bytes += (await fs.stat(path.join(folder, file.name))).size;
      }
    }
    return { bytes, count };
  }
  upload(id: string, originalName: string, bytes: Buffer): Promise<StoredDocument> {
    return this.run(async () => {
      const folder = this.folder(id), name = safeName(originalName);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
        throw new AttachmentError('单个附件不能超过 20 MB，且不能为空。', 413);
      }
      if (documentExtension(name) === '.pdf' &&
        (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 1024).toString('latin1').trimStart()) ||
          !bytes.subarray(-2048).includes(Buffer.from('%%EOF')))) {
        throw new AttachmentError('文件内容不是有效的 PDF，请重新选择。', 422);
      }
      const used = await this.sweep();
      const digest = createHash('sha256').update(bytes).digest('hex');
      const existing = await this.metadata(id);
      if (existing) {
        if (existing.digest !== digest || existing.name !== name) {
          throw new AttachmentError('附件标识已被其他文件使用，请重新选择文件。', 409);
        }
        const file = await fs.lstat(existing.path).catch(() => null);
        if (!file?.isFile() || file.isSymbolicLink() || file.size !== existing.size) {
          throw new AttachmentError('附件已不可用，请移除后重新上传。', 410);
        }
        return existing;
      }
      if (used.count >= MAX_DOCUMENT_COUNT || used.bytes + bytes.length + 4096 > this.storageLimit) {
        throw new AttachmentError('附件存储空间已满，请在主机清理不再需要的附件后重试。', 507);
      }
      await fs.rm(folder, { recursive: true, force: true });
      await fs.mkdir(folder, { mode: 0o700 });
      const document: StoredDocument = {
        id: id.toLowerCase(), name, path: path.resolve(folder, name), size: bytes.length,
        digest, createdAt: this.now(), retained: false
      };
      try {
        await fs.writeFile(document.path, bytes, { mode: 0o600, flag: 'wx' });
        await fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify(document), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        await fs.rm(folder, { recursive: true, force: true });
        throw error;
      }
      return document;
    });
  }
  retain(id: string): Promise<void> {
    return this.run(async () => {
      await this.rootReady();
      const document = await this.metadata(id);
      if (!document || this.now() - document.createdAt > UNUSED_LIFETIME_MS && !document.retained) {
        throw new AttachmentError('附件已过期，请移除后重新上传。', 410);
      }
      const stat = await fs.lstat(document.path).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== document.size) {
        throw new AttachmentError('附件已不可用，请移除后重新上传。', 410);
      }
      if (!document.retained) {
        const temporary = path.join(this.folder(id), `retained-${randomUUID()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify({ ...document, retained: true }),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, path.join(this.folder(id), 'metadata.json'));
      }
    });
  }
}

export function documentAttachmentRouter(authenticate: RequestHandler, trusted: RequestHandler,
  documents: DocumentAttachments): Router {
  const router = Router();
  let receiving = 0;
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(authenticate, trusted);
  router.post('/:id/retain', async (req, res, next) => {
    try { await documents.retain(String(req.params.id)); res.json({ retained: true }); }
    catch (error) { next(error); }
  });
  router.post('/:id', (req, res, next) => {
    if (receiving >= 4) { res.status(429).json({ error: '正在上传其他附件，请稍后重试。' }); return; }
    receiving++;
    let released = false;
    const release = () => { if (!released) { released = true; receiving--; } };
    res.once('finish', release); res.once('close', release);
    next();
  }, raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), authenticate, async (req, res, next) => {
    try {
      let name = '';
      try { name = decodeURIComponent(req.get('x-attachment-name') ?? ''); }
      catch { throw new AttachmentError('附件文件名无效。'); }
      const document = await documents.upload(String(req.params.id), name, req.body as Buffer);
      res.status(201).json({ id: document.id, name: document.name, path: document.path, size: document.size });
    } catch (error) { next(error); }
  });
  router.use(((error, _req, res, _next) => {
    const status = error instanceof AttachmentError ? error.status
      : (error as { type?: string }).type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ error: error instanceof AttachmentError ? error.message
      : status === 413 ? '单个附件不能超过 20 MB。' : '附件保存失败，请重试。' });
  }) as import('express').ErrorRequestHandler);
  return router;
}
