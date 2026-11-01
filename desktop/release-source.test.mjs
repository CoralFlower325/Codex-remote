import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetEndpoints, distributionOrigin, releaseEndpoints } from './release-source.mjs';
import { latestRelease } from './release.mjs';
import { downloadAsset, sha256 } from './runtime-package.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function target() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-download-source-'));
  roots.push(root);
  return path.join(root, 'download');
}
const bytes = Buffer.from('verified synthetic runtime');
const name = 'codex-remote-runtime-0.2.9-darwin-arm64.tar.gz';
const official = `https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/${name}`;
const mirror = `${distributionOrigin}/releases/download/v0.2.9/${name}`;
const asset = { name, browser_download_url: official, size: bytes.length, digest: `sha256:${sha256(bytes)}` };
const metadata = () => ({ tag_name: 'v0.2.9', body: 'release notes', assets: [asset] });

describe('fixed release distribution sources', () => {
  it('uses exactly the configured distribution and official repository', () => {
    expect(releaseEndpoints).toEqual([
      `${distributionOrigin}/releases/latest`,
      'https://api.github.com/repos/CoralFlower325/Codex-remote/releases/latest'
    ]);
    expect(assetEndpoints(asset)).toEqual([mirror, official]);
  });
  it.each([
    'http://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/package.tar.gz',
    'https://github.com:444/CoralFlower325/Codex-remote/releases/download/v0.2.9/package.tar.gz',
    'https://user:secret@github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/package.tar.gz',
    'https://github.com.evil.test/CoralFlower325/Codex-remote/releases/download/v0.2.9/package.tar.gz',
    'https://github.com/other/project/releases/download/v0.2.9/package.tar.gz',
    'https://github.com/CoralFlower325/Codex-remote/releases/download/main/package.tar.gz',
    'https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/subdir/package.tar.gz',
    'https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/package.tar.gz?token=private',
    'https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/package.tar.gz#fragment',
    'https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/%2e%2e/private',
    'https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.9/a%2fb.tar.gz'
  ])('rejects an untrusted asset URL before issuing a download: %s', async browser_download_url => {
    const fetcher = vi.fn();
    expect(() => assetEndpoints({ ...asset, browser_download_url })).toThrow();
    const file = await target();
    await expect(downloadAsset({ ...asset, browser_download_url }, file, { fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fs.access(file)).rejects.toThrow();
  });
});

describe('release metadata fallback', () => {
  it('uses the mirror once when valid and retains the official asset metadata', async () => {
    const fetcher = vi.fn(async () => Response.json(metadata()));
    const result = await latestRelease('0.2.7', fetcher);
    expect(result).toMatchObject({ version: '0.2.9', available: true, assets: [asset] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(releaseEndpoints[0]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Accept: 'application/vnd.github+json' }, redirect: 'error'
    });
  });
  it.each(['network', 'http', 'json', 'draft', 'prerelease', 'tag'])(
    'falls back once to official metadata after invalid mirror %s', async failure => {
      const cancelled = vi.fn();
      const fetcher = vi.fn(async endpoint => {
        if (endpoint === releaseEndpoints[1]) return Response.json(metadata());
        if (failure === 'network') throw new Error('ETIMEDOUT');
        if (failure === 'http') return new Response(new ReadableStream({ cancel: cancelled }), { status: 503 });
        if (failure === 'json') return new Response('not JSON');
        const data = metadata();
        if (failure === 'tag') data.tag_name = 'main';
        else data[failure] = true;
        return Response.json(data);
      });
      expect((await latestRelease('0.2.7', fetcher)).version).toBe('0.2.9');
      expect(fetcher.mock.calls.map(call => call[0])).toEqual(releaseEndpoints);
      if (failure === 'http') expect(cancelled).toHaveBeenCalledOnce();
    });
  it('exhausts both fixed metadata sources without accepting an invalid release', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...metadata(), prerelease: true }));
    await expect(latestRelease('0.2.7', fetcher)).rejects.toThrow('Invalid stable release');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps numeric version comparison and bounded notes on mirrored metadata', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...metadata(), body: 'x'.repeat(20_000) }));
    const result = await latestRelease('0.2.9', fetcher);
    expect(result.available).toBe(false);
    expect(result.notes).toHaveLength(16_000);
    expect((await latestRelease('0.2.10', fetcher)).available).toBe(false);
  });
});

describe('verified download fallback', () => {
  it('streams a mirror download and checks its bytes before returning', async () => {
    const file = await target();
    const fetcher = vi.fn(async () => new Response(bytes));
    const progress = vi.fn();
    await downloadAsset(asset, file, { fetcher, progress });
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(mirror);
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  });
  it('removes a partial mirror file before starting the official download', async () => {
    const file = await target();
    let chunks = 0;
    const broken = new Response(new ReadableStream({
      pull(controller) {
        if (++chunks === 1) controller.enqueue(bytes.subarray(0, 5));
        else controller.error(new Error('ECONNRESET'));
      }
    }, { highWaterMark: 0 }));
    const fetcher = vi.fn(async endpoint => {
      if (endpoint === mirror) return broken;
      await expect(fs.access(file)).rejects.toThrow();
      return new Response(bytes);
    });
    await downloadAsset(asset, file, { fetcher });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([mirror, official]);
    expect(fetcher.mock.calls[1][1].redirect).toBe('follow');
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(broken.body.locked).toBe(false);
  });
  it.each(['hash', 'short', 'oversize'])(
    'rejects mirror %s corruption and accepts only a verified official download', async kind => {
      const file = await target();
      const corrupt = kind === 'hash' ? Buffer.alloc(bytes.length, 0)
        : kind === 'short' ? bytes.subarray(0, 5) : Buffer.concat([bytes, Buffer.from('extra')]);
      const fetcher = vi.fn(async endpoint => new Response(endpoint === mirror ? corrupt : bytes));
      await downloadAsset(asset, file, { fetcher });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(file)).toEqual(bytes);
    });
  it('cancels a rejected HTTP response before downloading from the next source', async () => {
    const file = await target();
    const cancelled = vi.fn();
    const fetcher = vi.fn(async endpoint => endpoint === mirror
      ? new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }) : new Response(bytes));
    await downloadAsset(asset, file, { fetcher });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(file)).toEqual(bytes);
  });
  it('cleans both failed downloads and never accepts a same-size hash mismatch', async () => {
    const file = await target();
    const fetcher = vi.fn(async () => new Response(Buffer.alloc(bytes.length, 0)));
    await expect(downloadAsset(asset, file, { fetcher })).rejects.toThrow('\u6821\u9a8c\u5931\u8d25');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(fs.access(file)).rejects.toThrow();
  });
  it('preserves an existing target and cancels the unused response without fallback', async () => {
    const file = await target();
    const existing = Buffer.from('caller owned existing file');
    await fs.writeFile(file, existing);
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    await expect(downloadAsset(asset, file, { fetcher })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await fs.readFile(file)).toEqual(existing);
  });
  it('fails both unavailable sources without creating or replacing a target', async () => {
    const file = await target();
    const fetcher = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(downloadAsset(asset, file, { fetcher })).rejects.toThrow('ETIMEDOUT');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(fs.access(file)).rejects.toThrow();
  });
  it.each([
    { digest: '' }, { digest: 'sha256:invalid' }, { size: 0 }, { size: 512 * 1024 * 1024 + 1 }
  ])('refuses invalid integrity metadata before opening a connection: %j', async invalid => {
    const file = await target();
    const fetcher = vi.fn();
    await expect(downloadAsset({ ...asset, ...invalid }, file, { fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fs.access(file)).rejects.toThrow();
  });
});
