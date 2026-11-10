import { api } from './api';
import { previewContentUrl } from '../shared/file-preview';
import { documentExtension } from '../shared/document-formats';
import type { ComposerAttachment, ComposerDocumentAttachment } from './types';

let uploading = 0;
const waiting: Array<() => void> = [];
export async function uploadDocument(file: File, id: string): Promise<ComposerDocumentAttachment> {
  if (uploading >= 3) await new Promise<void>(resolve => waiting.push(resolve));
  else uploading++;
  try {
    const result = await api<{ id: string; name: string; path: string; size: number }>(
      `/api/attachments/${encodeURIComponent(id)}`, {
        method: 'POST', body: file, timeoutMs: 120000,
        headers: {
          'Content-Type': documentExtension(file.name) === '.pdf' ? 'application/pdf' : 'application/octet-stream',
          'X-Attachment-Name': encodeURIComponent(file.name)
        }
      });
    return { id: result.id, uploadId: result.id, name: result.name, path: result.path,
      size: result.size, url: previewContentUrl(result.path), kind: 'document' };
  } finally {
    const next = waiting.shift();
    if (next) next();
    else uploading--;
  }
}

export async function retainDocuments(attachments: ComposerAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    if (attachment.kind !== 'document' || !attachment.uploadId) continue;
    await api(`/api/attachments/${encodeURIComponent(attachment.uploadId)}/retain`, {
      method: 'POST', body: '{}', timeoutMs: 15000
    });
  }
}
