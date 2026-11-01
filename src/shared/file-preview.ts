export type PreviewTarget =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'url'; url: string };

export interface PreviewFile {
  path: string;
  name: string;
  kind: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'office' | 'binary';
  contentUrl: string;
  previewUrl?: string;
  text?: string;
  truncated: boolean;
}

export function previewContentUrl(filePath: string): string {
  return '/api/file-preview/content/' + filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}
