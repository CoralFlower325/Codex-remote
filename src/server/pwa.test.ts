import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { pwaPlugin, serviceWorkerSource } from '../../scripts/pwa.js';

function worker(shell: Response | undefined) {
  const handlers = new Map<string, (event: unknown) => void>();
  const cache = { match: vi.fn(async () => shell), put: vi.fn(async () => {}) };
  const fetch = vi.fn(async () => new Response('network-shell'));
  const showNotification = vi.fn(async () => {});
  const skipWaiting = vi.fn(async () => {});
  const deleteCache = vi.fn(async () => true);
  const clients = { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => [] as Array<{
    url: string; focus: () => Promise<void>; postMessage: (message: unknown) => void;
  }>), openWindow: vi.fn(async (_url: string) => {}) };
  runInNewContext(serviceWorkerSource(['/', '/assets/entry.js'], 'current'), {
    self: { location: { origin: 'https://remote.example' }, registration: { showNotification }, clients, skipWaiting,
      addEventListener: (name: string, handler: (event: unknown) => void) =>
      handlers.set(name, handler) },
    caches: { open: vi.fn(async () => cache), match: vi.fn(async () => shell),
      keys: vi.fn(async () => ['codex-static-old', 'codex-static-current', 'unrelated-cache']), delete: deleteCache },
    fetch, URL
  });
  const request = (path: string, mode = 'navigate') => {
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: { url: `https://remote.example${path}`, method: 'GET', mode },
      respondWith: (result: Promise<Response>) => { response = result; }
    });
    return response;
  };
  return { request, fetch, cache, handlers, clients, showNotification, skipWaiting, deleteCache };
}

describe('installed static shell', () => {
  it('returns the installed version immediately without a network race', async () => {
    const installed = new Response('installed-shell');
    const { request, fetch, cache } = worker(installed);
    expect(await request('/')).toBe(installed);
    expect(cache.match).toHaveBeenCalledWith('/');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the network when the shell was evicted', async () => {
    const { request, fetch } = worker(undefined);
    expect(await (await request('/'))!.text()).toBe('network-shell');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('never intercepts authenticated API and media requests', () => {
    const { request, cache, fetch } = worker(new Response('public-shell'));
    expect(request('/api/bootstrap', 'cors')).toBeUndefined();
    expect(request('/api/threads', 'cors')).toBeUndefined();
    expect(request('/api/local-image', 'cors')).toBeUndefined();
    expect(request('/version.json?check=123', 'cors')).toBeUndefined();
    expect(request('/update.html')).toBeUndefined();
    expect(cache.match).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('explicit application update', () => {
  it('publishes main-entry build metadata even when the recovery entry appears first', () => {
    const plugin = pwaPlugin('0.1.8');
    const generate = plugin.generateBundle;
    if (typeof generate !== 'function') throw new Error('Missing build hook');
    const emitFile = vi.fn();
    generate.call({ emitFile } as never, {} as never, {
      'assets/update-first.js': { type: 'chunk', name: 'update', isEntry: true, fileName: 'assets/update-first.js' },
      'assets/index-main.js': { type: 'chunk', name: 'index', isEntry: true, fileName: 'assets/index-main.js' }
    } as never, false);
    const manifest = emitFile.mock.calls.map(([file]) => file).find(file => file.fileName === 'version.json');
    expect(JSON.parse(manifest.source)).toMatchObject({ version: '0.1.8', buildId: 'assets/index-main.js',
      releases: expect.arrayContaining([expect.objectContaining({ version: '0.1.8', changes: expect.any(Array) })]) });
  });

  it('activates only on an explicit message from its own origin', async () => {
    const { handlers, skipWaiting } = worker(undefined);
    const message = handlers.get('message')!;
    let pending: Promise<unknown> | undefined;
    const waitUntil = (value: Promise<unknown>) => { pending = value; };
    message({ data: { type: 'codex-update:activate' }, source: { url: 'https://other.example/' }, waitUntil });
    message({ data: { type: 'unknown' }, source: { url: 'https://remote.example/' }, waitUntil });
    message({ data: { type: 'codex-update:activate' }, source: null, waitUntil });
    expect(skipWaiting).not.toHaveBeenCalled();
    message({ data: { type: 'codex-update:activate' }, source: { url: 'https://remote.example/update.html' }, waitUntil });
    await pending;
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it('reports the actual installed build without exposing private runtime state', () => {
    const { handlers, cache } = worker(undefined);
    const postMessage = vi.fn();
    handlers.get('message')!({ data: { type: 'codex-update:build' },
      source: { url: 'https://remote.example/' }, ports: [{ postMessage }] });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ version: '0.0.0', buildId: 'current' });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('keeps old public assets for other tabs during a manual update and cleans them on natural activation', async () => {
    const manual = worker(undefined);
    let pending: Promise<unknown> | undefined;
    const waitUntil = (value: Promise<unknown>) => { pending = value; };
    manual.handlers.get('message')!({ data: { type: 'codex-update:activate' },
      source: { url: 'https://remote.example/' }, waitUntil });
    await pending;
    manual.handlers.get('activate')!({ waitUntil }); await pending;
    expect(manual.deleteCache).not.toHaveBeenCalled();
    expect(manual.clients.claim).toHaveBeenCalledOnce();
    const natural = worker(undefined);
    natural.handlers.get('activate')!({ waitUntil }); await pending;
    expect(natural.deleteCache).toHaveBeenCalledExactlyOnceWith('codex-static-old');
  });
});

describe('device push notifications', () => {
  it('displays a background notification and opens the matching chat in an existing workspace', async () => {
    const { handlers, showNotification, clients, cache } = worker(undefined);
    let pending!: Promise<unknown>;
    handlers.get('push')!({
      data: { json: () => ({ title: 'Codex', body: 'Task completed', tag: 'turn-a', url: '/?thread=a' }) },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; }
    });
    await pending;
    expect(showNotification).toHaveBeenCalledWith('Codex', expect.objectContaining({
      body: 'Task completed', data: { url: '/?thread=a' }
    }));
    const client = { url: 'https://remote.example/', focus: vi.fn(async () => {}),
      postMessage: vi.fn() };
    clients.matchAll.mockResolvedValue([client]);
    const close = vi.fn();
    handlers.get('notificationclick')!({
      notification: { close, data: { url: '/?thread=a' } },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; }
    });
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(client.focus).toHaveBeenCalledOnce();
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'notification.open', threadId: 'a' });
    expect(clients.openWindow).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('opens a closed workspace on notification tap and keeps navigation on its own origin', async () => {
    const { handlers, clients } = worker(undefined);
    let pending!: Promise<unknown>;
    const tap = async (url: string) => {
      handlers.get('notificationclick')!({
        notification: { close: () => {}, data: { url } },
        waitUntil: (promise: Promise<unknown>) => { pending = promise; }
      });
      await pending;
    };
    await tap('/?thread=chat%20a');
    expect(clients.openWindow).toHaveBeenLastCalledWith('https://remote.example/?thread=chat%20a');
    await tap('https://elsewhere.example/');
    expect(clients.openWindow).toHaveBeenLastCalledWith('https://remote.example/');
  });
});
