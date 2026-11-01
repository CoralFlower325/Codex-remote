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
    try {
      const pending = Promise.resolve().then(() => fetcher(url, {
        ...options, signal: controller.signal,
        ...(createDispatcher ? { dispatcher: dispatcher ||= createDispatcher() } : {})
      }));
      // A test double or late transport response may resolve after cancellation.
      pending.then((response) => {
        if (ended) Promise.resolve(response.body?.cancel(controller.signal.reason)).catch(() => {});
      }, () => {});
      const response = await Promise.race([pending, cancelled]);
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

