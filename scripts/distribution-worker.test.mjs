import { describe, expect, it, vi } from 'vitest';
import { handleDistribution } from '../distribution/worker.mjs';
import { checkedReleaseSnapshot } from './refresh-distribution-release.mjs';

const origin = 'https://downloads.example.com';
const route = '/releases/download/v0.3.0/codex-remote-runtime-0.3.0-win32-x64.tar.gz';
const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/1432790152/file?sig=private';
const latest = () => new Response(JSON.stringify({ tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [] }));

describe('bounded official release distribution', () => {
  it.each([
    ['/anything', 'GET'], ['/releases/latest?url=https://example.com', 'GET'],
    ['/releases/latest', 'POST'], ['/releases/download/v0.3.0/evil.exe', 'GET'],
    ['/releases/download/v0.3.0/%2e%2e%2f.env', 'GET'],
    ['/releases/download/v0.3.0/codex-remote-runtime-0.3.0-linux-x64.tar.gz', 'GET']
  ])('rejects unsupported routes before fetching %s %s', async (path, method) => {
    const fetcher = vi.fn();
    expect((await handleDistribution(new Request(origin + path, { method }), { fetcher })).status).toBeGreaterThanOrEqual(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches only fixed official metadata, strips secrets and caches checked JSON for 60 seconds', async () => {
    let saved;
    const cache = { match: vi.fn(async () => saved?.clone()), put: vi.fn(async (_key, value) => { saved = value; }) };
    const fetcher = vi.fn(async () => latest());
    const request = new Request(origin + '/releases/latest', { headers: { Cookie: 'secret', Authorization: 'secret' } });
    const result = await handleDistribution(request, { fetcher, cache });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('public, max-age=60');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/CoralFlower325/Codex-remote/releases/latest');
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Cookie');
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    const head = await handleDistribution(new Request(request.url, { method: 'HEAD' }), { fetcher, cache });
    expect(await head.text()).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'HEAD'])('restores the public metadata TTL on a platform cached %s response', async method => {
    const fetcher = vi.fn();
    const cache = { match: vi.fn(async () => new Response('checked metadata', {
      headers: { 'cache-control': 'public, max-age=14400', 'x-release-source': 'release-snapshot',
        'x-distribution-cache-stored-at': String(Date.now()) }
    })) };
    const result = await handleDistribution(new Request(origin + '/releases/latest', { method }), { fetcher, cache });
    expect(result.headers.get('cache-control')).toBe('public, max-age=60');
    expect(result.headers.get('x-release-source')).toBe('release-snapshot');
    expect(result.headers.has('x-distribution-cache-stored-at')).toBe(false);
    expect(await result.text()).toBe(method === 'HEAD' ? '' : 'checked metadata');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([String(Date.now() - 60_001), '0', 'invalid'])('ignores stale or legacy cached metadata %s', async timestamp => {
    const fetcher = vi.fn(async () => latest());
    const cache = { match: vi.fn(async () => new Response('old release', {
      headers: { 'cache-control': 'public, max-age=14400', 'x-distribution-cache-stored-at': timestamp }
    })), put: vi.fn() };
    const response = await handleDistribution(new Request(origin + '/releases/latest'), { fetcher, cache });
    expect(response.status).toBe(200);
    expect((await response.json()).tag_name).toBe('v0.3.0');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.has('x-distribution-cache-stored-at')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('streams a manager installer through an allowed signed CDN without buffering or leaking redirect data', async () => {
    const name = '/releases/download/v0.3.0/Codex-Remote-Manager-0.2.1-win-x64.exe';
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdn } }))
      .mockResolvedValueOnce(new Response(body, { headers: { 'content-length': '121702210', 'content-type': 'application/octet-stream',
        'set-cookie': 'secret', 'content-disposition': 'attachment; filename="manager.exe"' } }));
    const result = await handleDistribution(new Request(origin + name), { fetcher });
    expect(result.body).not.toBeNull();
    expect(result.headers.get('content-length')).toBe('121702210');
    expect(result.headers.get('location')).toBeNull();
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(fetcher.mock.calls[0][0]).toBe('https://github.com/CoralFlower325/Codex-remote' + name);
    expect(fetcher.mock.calls[1][0]).toBe(cdn);
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it.each([
    'https://example.com/file', 'http://release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com/github-production-release-asset/999/file',
    'https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/1432790152/file',
    'https://release-assets.githubusercontent.com:444/github-production-release-asset/1432790152/file'
  ])('rejects unexpected redirects %s', async location => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    const log = vi.fn();
    expect((await handleDistribution(new Request(origin + route), { fetcher, log })).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).not.toContain(location);
  });

  it('preserves a single byte range without forwarding other client headers', async () => {
    const fetcher = vi.fn(async () => new Response('ab', { status: 206, headers: { 'content-length': '2',
      'content-range': 'bytes 0-1/10', 'accept-ranges': 'bytes' } }));
    const result = await handleDistribution(new Request(origin + route, { headers: { range: 'bytes=0-1', cookie: 'secret' } }), { fetcher });
    expect(result.status).toBe(206);
    expect(result.headers.get('content-range')).toBe('bytes 0-1/10');
    expect(fetcher.mock.calls[0][1].headers.Range).toBe('bytes=0-1');
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('cookie');
    expect((await handleDistribution(new Request(origin + route, { headers: { range: 'bytes=0-1,4-5' } }), { fetcher })).status).toBe(416);
  });

  it('bounds metadata and never caches malformed or upstream error responses', async () => {
    const cache = { match: vi.fn(), put: vi.fn() };
    const log = vi.fn();
    for (const response of [new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      new Response('not json'), new Response('{}'), new Response('rate limit', { status: 403 })]) {
      expect((await handleDistribution(new Request(origin + '/releases/latest'),
        { fetcher: async () => response, cache, log })).status).toBe(502);
    }
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('cancels oversized metadata before reading and limits a stalled body to 15 seconds', async () => {
    const cancel = vi.fn();
    const oversized = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(1024 * 1024 + 1) }
    });
    const log = vi.fn();
    await handleDistribution(new Request(origin + '/releases/latest'), { fetcher: async () => oversized, log });
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      const stalledCancel = vi.fn();
      const pending = handleDistribution(new Request(origin + '/releases/latest'), {
        fetcher: async () => new Response(new ReadableStream({ cancel: stalledCancel })), log
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await pending).status).toBe(502);
      expect(stalledCancel).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('uses the checked bundled snapshot when GitHub API is rate limited without weakening file digests', async () => {
    const snapshot = { generatedAt: '2026-11-01T00:00:00.000Z',
      release: { tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [] } };
    const response = await handleDistribution(new Request(origin + '/releases/latest'), {
      fetcher: async () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      snapshot, log: vi.fn()
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-release-source')).toBe('release-snapshot');
    expect(response.headers.get('x-release-upstream-status')).toBe('403');
    expect(response.headers.get('x-release-snapshot-at')).toBe(snapshot.generatedAt);
    expect((await response.json()).tag_name).toBe('v0.3.0');
  });

  it('requires complete official runtime metadata and SHA256 when generating a snapshot', () => {
    const assets = ['win32-x64', 'darwin-arm64'].flatMap(platform => ['json', 'tar.gz'].map(extension => {
      const name = `codex-remote-runtime-0.3.0-${platform}.${extension}`;
      return { name, size: 100, digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: `https://github.com/CoralFlower325/Codex-remote/releases/download/v0.3.0/${name}` };
    }));
    const release = { tag_name: 'v0.3.0', draft: false, prerelease: false, assets };
    expect(checkedReleaseSnapshot(release).release.assets).toHaveLength(4);
    expect(() => checkedReleaseSnapshot({ ...release, assets: assets.slice(0, 3) })).toThrow('publishing');
    expect(() => checkedReleaseSnapshot({ ...release, assets: assets.map(asset => ({ ...asset, digest: null })) })).toThrow();
    expect(() => checkedReleaseSnapshot({ ...release, assets: assets.map(asset => ({
      ...asset, browser_download_url: 'https://example.com/asset'
    })) })).toThrow();
  });
});
