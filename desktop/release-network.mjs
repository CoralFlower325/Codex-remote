function responseMetadata(response, source) {
  for (const key of ['url', 'redirected', 'type']) {
    Object.defineProperty(response, key, { value: source[key], configurable: true });
  }
  const clone = response.clone.bind(response);
  response.clone = () => responseMetadata(clone(), source);
  return response;
}

export function createReleaseFetch({ fetcher = fetch,
  createDispatcher, headersTimeout = 30_000,
  idleTimeout = 60_000 } = {}) {
  // Reuse explicit environment proxy settings without changing global dispatch.
  let dispatcher;
  return async (url, options = {}) => {
    const signal = options.signal ?? (typeof url === 'object' ? url.signal : undefined);
    const method = String(options.method ?? (typeof url === 'object' ? url.method : undefined) ?? 'GET').toUpperCase();
    const allowDirectFallback = method === 'GET' || method === 'HEAD';
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timer, reader, stream, rejectHeaders, ended = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
    };
    const releaseReader = (reason) => {
      const current = reader;
      reader = null;
      if (!current) return;
      Promise.resolve(current.cancel(reason)).catch(() => {}).finally(() => {
        try { current.releaseLock(); } catch {}
      });
    };
    const fail = (error) => {
      if (ended) return;
      ended = true;
      cleanup();
      controller.abort(error);
      rejectHeaders?.(error);
      stream?.error(error);
      releaseReader(error);
    };
    const aborted = () => fail(signal.reason);
    const deadline = (duration, phase) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(Object.assign(
        new Error(`ETIMEDOUT: release download ${phase} timed out.`), { code: 'ETIMEDOUT' }
      )), duration);
    };
    signal?.addEventListener('abort', aborted, { once: true });
    const cancelled = new Promise((_, reject) => { rejectHeaders = reject; });
    deadline(headersTimeout, 'response headers');
    const issue = (withDispatcher) => {
      let abandoned = false;
      const pending = Promise.resolve().then(() => fetcher(url, {
        ...options, signal: controller.signal,
        ...(withDispatcher && createDispatcher ? { dispatcher: dispatcher ||= createDispatcher() } : {})
      }));
      // A test double or late transport response may resolve after cancellation
      // or after the direct fallback has already won the race.
      pending.then((response) => {
        if (ended || abandoned) Promise.resolve(response.body?.cancel(controller.signal.reason)).catch(() => {});
      }, () => {});
      return { pending, abandon: () => { abandoned = true; } };
    };
    try {
      let attempt = issue(true);
      let response;
      try {
        response = await Promise.race([attempt.pending, cancelled]);
      } catch (error) {
        // A failed explicit proxy must not hide a directly reachable release
        // source. Keep this retry within the original headers/caller deadlines.
        if (ended || signal?.aborted || !createDispatcher || !allowDirectFallback) throw error;
        attempt.abandon();
        attempt = issue(false);
        response = await Promise.race([attempt.pending, cancelled]);
      }
      rejectHeaders = null;
      clearTimeout(timer);
      if (!response.body) {
        ended = true;
        cleanup();
        return response;
      }
      reader = response.body.getReader();
      deadline(idleTimeout, 'body inactivity');
      const body = new ReadableStream({
        start(value) { stream = value; },
        async pull(value) {
          try {
            const result = await reader.read();
            if (ended) return;
            if (result.done) {
              ended = true;
              cleanup();
              reader.releaseLock();
              reader = null;
              value.close();
            } else {
              if (result.value.byteLength) deadline(idleTimeout, 'body inactivity');
              value.enqueue(result.value);
            }
          } catch (error) { fail(error); }
        },
        cancel(reason) {
          if (ended) return;
          ended = true;
          cleanup();
          controller.abort(reason);
          releaseReader(reason);
        }
      }, { highWaterMark: 0 });
      return responseMetadata(new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      }), response);
    } catch (error) {
      fail(error);
      throw error;
    }
  };
}

