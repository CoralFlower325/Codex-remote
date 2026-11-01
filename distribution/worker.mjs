const repository = 'CoralFlower325/Codex-remote';
const repositoryId = '1432790152';
const metadataUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const version = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const assetName = new RegExp(`^(?:codex-remote-runtime-${version}-(?:win32-x64|darwin-arm64)\\.(?:json|tar\\.gz)|Codex-Remote-Manager-${version}-(?:win-x64\\.exe|mac-arm64\\.(?:dmg|zip)))$`);
const assetPath = new RegExp(`^/releases/download/v${version}/([A-Za-z0-9._-]{1,180})$`);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const publicHeaders = ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified',
  'accept-ranges', 'content-range'];
const cacheTimestamp = 'X-Distribution-Cache-Stored-At';

async function cacheMetadata(cache, key, result) {
  if (!cache) return;
  const headers = new Headers(result.headers);
  headers.set(cacheTimestamp, String(Date.now()));
  try { await cache.put(key, new Response(result.clone().body, { status: result.status, headers })); }
  catch { /* A cache failure must not block checked public metadata. */ }
}

function failure(status, message, extra = {}) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra } });
}

function validRedirect(url) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    url.hostname === 'release-assets.githubusercontent.com' &&
    url.pathname.startsWith(`/github-production-release-asset/${repositoryId}/`);
}

async function upstream(url, method, headers, fetcher) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Upstream headers timed out.')), 30_000);
    let response;
    try {
      response = await fetcher(url, { method, headers, redirect: 'manual', signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!redirectStatuses.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 3) throw new Error('Invalid upstream redirect.');
    const target = new URL(location, url);
    if (!validRedirect(target)) throw new Error('Rejected upstream redirect.');
    url = target.href;
  }
  throw new Error('Too many upstream redirects.');
}

async function boundedMetadata(response) {
  const limit = 1024 * 1024;
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > limit) {
    response.body?.cancel().catch(() => {});
    throw new Error('Release metadata is too large.');
  }
  if (!response.body) throw new Error('Release metadata is empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Release metadata timed out.')), 15_000);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Release metadata is too large.');
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (data.draft !== false || data.prerelease !== false ||
    !new RegExp(`^v${version}$`).test(data.tag_name) || !Array.isArray(data.assets)) {
    throw new Error('Invalid stable release metadata.');
  }
  return bytes;
}

async function snapshotResponse(request, snapshot, cache, key, status) {
  if (!snapshot?.release || !snapshot.generatedAt) return null;
  const bytes = await boundedMetadata(new Response(JSON.stringify(snapshot.release)));
  const result = new Response(bytes, { headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.byteLength), 'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff', 'X-Release-Source': 'release-snapshot',
    'X-Release-Snapshot-At': snapshot.generatedAt,
    ...(status ? { 'X-Release-Upstream-Status': String(status) } : {}) } });
  await cacheMetadata(cache, key, result);
  return request.method === 'HEAD' ? new Response(null, result) : result;
}

export async function handleDistribution(request, { fetcher = fetch, cache, snapshot, log = console.error } = {}) {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
  if (url.search || url.username || url.password || url.hash) return failure(400, 'Invalid download request.');
  const metadata = url.pathname === '/releases/latest';
  const asset = assetPath.exec(url.pathname);
  if (!metadata && (!asset || !assetName.test(asset[1]))) return failure(404, 'Download not found.');
  const headers = { 'User-Agent': 'Codex-Remote-Distribution', Accept: metadata
    ? 'application/vnd.github+json' : 'application/octet-stream', 'Accept-Encoding': 'identity' };
  // Client credentials, cookies and arbitrary headers never cross this boundary.
  if (!metadata && request.headers.has('range')) {
    const range = request.headers.get('range');
    if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return failure(416, 'Invalid byte range.');
    headers.Range = range;
  }
  const key = new Request(`${url.origin}/releases/latest`);
  let upstreamStatus;
  try {
    if (metadata) {
      const cached = await cache?.match(key);
      if (cached) {
        const storedAt = Number(cached.headers.get(cacheTimestamp));
        const age = Date.now() - storedAt;
        if (Number.isFinite(storedAt) && storedAt > 0 && age >= 0 && age < 60_000) {
          const headers = new Headers(cached.headers);
          headers.set('Cache-Control', 'public, max-age=60');
          headers.delete(cacheTimestamp);
          return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers });
        }
        cached.body?.cancel().catch(() => {});
      }
    }
    const target = metadata ? metadataUrl : `https://github.com/${repository}${url.pathname}`;
    // Metadata HEAD uses the same checked GET representation and cache as GET.
    const response = await upstream(target, metadata ? 'GET' : request.method, headers, fetcher);
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      log(JSON.stringify({ message: 'Release upstream rejected request', path: url.pathname, status: response.status,
        remaining: response.headers.get('x-ratelimit-remaining') }));
      if (metadata) {
        const fallback = await snapshotResponse(request, snapshot, cache, key, response.status);
        if (fallback) return fallback;
      }
      return failure(response.status === 404 ? 404 : response.status === 429 ? 429 : 502, 'Official release is unavailable.',
        { 'X-Release-Upstream-Status': String(response.status),
          ...(response.headers.has('x-ratelimit-remaining')
            ? { 'X-Release-RateLimit-Remaining': response.headers.get('x-ratelimit-remaining') } : {}) });
    }
    const outputHeaders = new Headers({ 'Cache-Control': metadata ? 'public, max-age=60' : 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    for (const name of publicHeaders) {
      const value = response.headers.get(name);
      if (value !== null) outputHeaders.set(name, value);
    }
    if (metadata) {
      const bytes = await boundedMetadata(response);
      outputHeaders.set('X-Release-Source', 'github-api');
      outputHeaders.set('Content-Type', 'application/json; charset=utf-8');
      outputHeaders.set('Content-Length', String(bytes.byteLength));
      const result = new Response(bytes, { headers: outputHeaders });
      // Only bounded public JSON enters the cache, never installer streams.
      await cacheMetadata(cache, key, result);
      return request.method === 'HEAD' ? new Response(null, result) : result;
    }
    return new Response(request.method === 'HEAD' ? null : response.body,
      { status: response.status, headers: outputHeaders });
  } catch (error) {
    // Signed CDN locations and their query parameters must never appear in logs.
    const reason = error?.name === 'SyntaxError' ? 'invalid-json'
      : error?.message === 'Invalid stable release metadata.' ? 'invalid-metadata'
      : error?.message === 'Release metadata is too large.' ? 'metadata-limit'
      : error?.message === 'Release metadata timed out.' ? 'metadata-timeout' : 'upstream-network';
    log(JSON.stringify({ message: 'Release proxy failed', path: url.pathname, status: upstreamStatus, reason }));
    if (metadata) {
      try {
        const fallback = await snapshotResponse(request, snapshot, cache, key, upstreamStatus);
        if (fallback) return fallback;
      } catch { /* Fail closed if the bundled snapshot is invalid. */ }
    }
    return failure(502, 'Official release is unavailable.', { 'X-Release-Error': reason,
      ...(upstreamStatus ? { 'X-Release-Upstream-Status': String(upstreamStatus) } : {}) });
  }
}

export default {
  fetch(request) {
    return handleDistribution(request, { cache: caches.default });
  }
};
