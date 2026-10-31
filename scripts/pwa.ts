import type { Plugin } from 'vite';
import { releaseNotes } from '../src/shared/release-notes';

export function serviceWorkerSource(files: string[], version: string, appVersion = '0.0.0', originPrefix = ''): string {
  return `
const CACHE = ${JSON.stringify(`codex-static-${version}`)};
const ORIGIN_PREFIX = ${JSON.stringify(originPrefix)};
const FILES = ${JSON.stringify(files.map(file => file === '/' ? file : originPrefix + file))};
const BUILD = ${JSON.stringify({ version: appVersion, buildId: version })};
let userActivated = false;
const isStatic = url => url.origin === self.location.origin &&
  (url.pathname.startsWith('/assets/') || url.pathname === ORIGIN_PREFIX + '/' || FILES.includes(url.pathname));
self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => Promise.all(FILES.map(async path => {
    const response = await fetch(path === '/' ? ORIGIN_PREFIX + '/' : path, { cache: 'reload', credentials: 'omit', priority: 'low' });
    if (!response.ok) throw new Error('Application cache is incomplete.');
    await cache.put(path, response);
  })))
));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all((userActivated ? [] : keys).filter(key =>
    key.startsWith('codex-static-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener('message', event => {
  if (typeof event.source?.url !== 'string' ||
    !event.source.url.startsWith(self.location.origin + '/')) return;
  if (event.data?.type === 'codex-update:build') event.ports?.[0]?.postMessage(BUILD);
  if (event.data?.type === 'codex-update:activate') {
    // Other open tabs may still import their installed build's lazy modules.
    // Natural activation after the old clients close performs cache cleanup.
    userActivated = true;
    event.waitUntil(self.skipWaiting());
  }
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !isStatic(url) || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // Keep the shell and its modules in the same installed version.
      // Registration updates install the next version in the background.
      const cached = await (await caches.open(CACHE)).match('/');
      return cached || fetch(request);
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
    return response;
  })());
});
self.addEventListener('push', event => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(payload.title || 'Codex', {
    body: payload.body || 'Codex',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'codex-notification',
    data: { url: payload.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    let url = new URL(event.notification.data?.url || '/', self.location.origin);
    if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      const threadId = url.searchParams.get('thread');
      if (threadId) client.postMessage({ type: 'notification.open', threadId });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
`;
}

export function pwaPlugin(appVersion: string): Plugin {
  return {
    name: 'remote-static-cache',
    apply: 'build',
    transformIndexHtml(_html, context) {
      if (context.path === '/update.html') return [];
      const workspace = Object.values(context.bundle ?? {}).find(
        value => value.type === 'chunk' && value.name === 'Workspace'
      );
      return workspace ? [{ tag: 'link', attrs: {
        rel: 'modulepreload', crossorigin: '', href: `/${workspace.fileName}`
      }, injectTo: 'head' }] : [];
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(value => value.type === 'chunk' && value.isEntry && value.name === 'index');
      if (!entry) return;
      const files = ['/', '/codex-mark.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest',
        ...Object.keys(bundle).filter(name => /\.(js|css)$/.test(name) && !/^assets\/(?:TerminalPanel|FilePreview|PdfPreview)/.test(name))
          .map(name => `/${name}`)];
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({
        version: appVersion, buildId: entry.fileName, releases: releaseNotes
      }) });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(files, entry.fileName, appVersion) });
      this.emitFile({ type: 'asset', fileName: 'sw-origin.js',
        source: serviceWorkerSource(files, entry.fileName, appVersion, '/remote-client') });
    }
  };
}
