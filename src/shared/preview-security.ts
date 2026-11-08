const resourceExtensions = new Set([
  'css', 'js', 'mjs', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'mp3', 'ogg', 'wav', 'mp4', 'webm'
]);

export function safePreviewResource(relative: string): boolean {
  const parts = relative.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part.startsWith('.') ||
      /^(?:node_modules|data|output|config|secrets?|credentials?|private)$/i.test(part))) return false;
  const name = parts.at(-1)!;
  if (/(?:^|[._-])(?:env|secrets?|credentials?|tokens?|passwords?|private|auth|config)(?:[._-]|$)/i.test(name)) return false;
  return resourceExtensions.has(name.split('.').at(-1)?.toLowerCase() ?? '');
}

export function previewPolicy(resourceUrl?: string): string {
  const source = resourceUrl ? new URL('.', resourceUrl).href : "'none'";
  return [
    "default-src 'none'", `script-src 'unsafe-inline' ${source}`,
    `style-src 'unsafe-inline' ${source}`, `img-src data: blob: ${source}`,
    `font-src ${source}`, `media-src ${source}`, "connect-src 'none'",
    "frame-src 'none'", "object-src 'none'", "worker-src 'none'",
    "form-action 'none'", `base-uri ${source}`
  ].join('; ');
}
