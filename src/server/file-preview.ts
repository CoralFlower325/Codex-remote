import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { PreviewFile } from '../shared/file-preview.js';
import { normalizePreviewPath, previewContentUrl } from '../shared/file-preview.js';
import { OfficePreviews, OfficePreviewError, officeExtensions } from './office-preview.js';
import { previewRevision, previewWatchRouter } from './preview-watch.js';
import { safePreviewResource, previewPolicy } from '../shared/preview-security.js';

const MAX_TEXT_BYTES = 1024 * 1024;
const images = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg']);

export async function readPreviewFile(requestedPath: string): Promise<PreviewFile> {
  requestedPath = normalizePreviewPath(requestedPath);
  if (!path.isAbsolute(requestedPath)) throw new Error('An absolute file path is required.');
  const filePath = path.resolve(requestedPath);
  const info = await fs.stat(filePath);
  if (!info.isFile()) throw new Error('The selected path is not a file.');
  const extension = path.extname(filePath).toLowerCase();
  const result: PreviewFile = { path: filePath, name: path.basename(filePath), kind: 'text',
    contentUrl: previewContentUrl(filePath), revision: previewRevision(info), truncated: false };
  if (images.has(extension)) return { ...result, kind: 'image' };
  if (extension === '.pdf') return { ...result, kind: 'pdf' };
  if (officeExtensions.has(extension)) return { ...result, kind: 'office',
    previewUrl: `/api/file-preview/document?${new URLSearchParams({ path: filePath })}` };
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, Math.min(bytesRead, 8192)).includes(0)) return { ...result, kind: 'binary' };
    const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
    return { ...result, text, truncated: info.size > bytesRead,
      kind: ['.md', '.markdown', '.mdx'].includes(extension) ? 'markdown'
        : ['.html', '.htm'].includes(extension) ? 'html' : 'text' };
  } finally { await file.close(); }
}

export function filePreviewRouter(authenticate: RequestHandler, office = new OfficePreviews(),
  authorized: (req: Request) => boolean = () => true): Router {
  const router = Router();
  const grants = new Map<string, { directory: string; document: string; expires: number }>();
  const sendContent = (res: Response, filePath: string, resourceUrl?: string) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy',
      `sandbox allow-scripts; frame-ancestors 'self'; ${previewPolicy(resourceUrl)}`);
    res.sendFile(filePath, { dotfiles: 'allow' });
  };
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Opaque-origin scripts must never receive a general directory-reading token.
  // Only the chosen document and non-sensitive static resources are accessible.
  router.get('/render/:grant/*relativePath', async (req, res) => {
    const grant = grants.get(String(req.params.grant));
    if (!grant || grant.expires <= Date.now()) { res.sendStatus(401); return; }
    const parts = req.params.relativePath;
    const relative = Array.isArray(parts) ? parts.join('/') : parts ?? '';
    const filePath = path.resolve(grant.directory, relative);
    const within = path.relative(grant.directory, filePath);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) { res.sendStatus(403); return; }
    if (within !== grant.document && !safePreviewResource(within)) { res.sendStatus(403); return; }
    const realPath = await fs.realpath(filePath).catch(() => null);
    if (!realPath) { res.sendStatus(404); return; }
    const realRelative = path.relative(grant.directory, realPath);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      res.sendStatus(403); return;
    }
    if (realRelative !== grant.document && !safePreviewResource(realRelative)) { res.sendStatus(403); return; }
    const info = await fs.stat(realPath).catch(() => null);
    if (!info?.isFile()) { res.sendStatus(404); return; }
    res.setHeader('Access-Control-Allow-Origin', 'null');
    sendContent(res, realPath, `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}`);
  });
  router.use(authenticate);
  router.use(previewWatchRouter(authorized));
  router.get('/document', async (req, res) => {
    try {
      const pdf = await office.read(normalizePreviewPath(typeof req.query.path === 'string' ? req.query.path : ''));
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
      res.send(pdf);
    } catch (error) {
      if (res.destroyed) return;
      res.status(error instanceof OfficePreviewError ? error.status
        : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 422)
        .json({ error: error instanceof OfficePreviewError ? error.message : '文档预览失败，请下载原文件或刷新重试。' });
    }
  });
  router.get('/', async (req, res) => {
    const requestedPath = normalizePreviewPath(typeof req.query.path === 'string' ? req.query.path : '');
    if (!requestedPath || !path.isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'An absolute file path is required.' }); return;
    }
    try {
      const result = await readPreviewFile(requestedPath);
      if (result.kind === 'html') {
        for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key);
        const key = randomUUID();
        if (grants.size >= 500) grants.delete(grants.keys().next().value!);
        grants.set(key, { directory: await fs.realpath(path.dirname(result.path)),
          document: path.basename(result.path), expires: Date.now() + 15 * 60_000 });
        result.previewUrl = `/api/file-preview/render/${key}/${encodeURIComponent(result.name)}`;
      }
      res.json(result);
    }
    catch (error) {
      res.status((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400)
        .json({ error: (error as Error).message });
    }
  });
  router.get('/content/*filePath', async (req, res) => {
    const parts = req.params.filePath;
    const requestedPath = normalizePreviewPath((Array.isArray(parts) ? parts.join('/') : parts) ?? '');
    if (!requestedPath || !path.isAbsolute(requestedPath)) {
      res.status(400).json({ error: 'An absolute file path is required.' }); return;
    }
    const filePath = path.resolve(requestedPath);
    const info = await fs.stat(filePath).catch(() => null);
    if (!info?.isFile()) { res.status(404).json({ error: 'File was not found.' }); return; }
    sendContent(res, filePath);
  });
  return router;
}
