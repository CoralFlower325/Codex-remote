export type PreviewTarget =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'url'; url: string };

export interface PreviewFile {
  path: string;
  name: string;
  kind: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'office' | 'binary';
  contentUrl: string;
  previewUrl?: string;
  revision?: string;
  text?: string;
  truncated: boolean;
}

export function previewVersionUrl(url: string, revision: string | undefined): string {
  return revision ? `${url}${url.includes('?') ? '&' : '?'}revision=${encodeURIComponent(revision)}` : url;
}

export function normalizePreviewPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+([a-z]:\/)/i, '$1');
}

export function previewContentUrl(filePath: string): string {
  return '/api/file-preview/content/' + normalizePreviewPath(filePath).split('/').map(encodeURIComponent).join('/');
}
