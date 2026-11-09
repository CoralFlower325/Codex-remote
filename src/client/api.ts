interface ApiOptions extends RequestInit { timeoutMs?: number }

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { timeoutMs, signal, ...request } = options;
  const controller = timeoutMs ? new AbortController() : null;
  let timeoutError: DOMException | undefined;
  const abort = () => controller?.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs ? setTimeout(() => {
    timeoutError = new DOMException('连接超时，请重试。', 'TimeoutError');
    controller!.abort(timeoutError);
  }, timeoutMs) : undefined;
  try {
    const response = await fetch(path, {
      ...request,
      ...((controller?.signal ?? signal) ? { signal: controller?.signal ?? signal! } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {})
      },
      credentials: 'same-origin'
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `请求失败（HTTP ${response.status}）`;
      throw new HttpError(message, response.status);
    }

    return body as T;
  } catch (error) {
    // WebKit can reject fetch with AbortError even when abort used TimeoutError.
    throw timeoutError ?? error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function isAbortedRequest(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class ReadRequests {
  private pending = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();

  has(path: string): boolean {
    return this.pending.has(path);
  }

  get<T>(path: string, timeoutMs = 15000, attempts = 1): Promise<T> {
    const existing = this.pending.get(path);
    if (existing) return existing.promise as Promise<T>;
    const controller = new AbortController();
    const promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await api<T>(path, {
            cache: 'no-store', signal: controller.signal, timeoutMs: attempt === 0 ? timeoutMs : 15000
          });
        } catch (error) {
          if (controller.signal.aborted || attempt + 1 >= attempts ||
              error instanceof HttpError && error.status !== 429 && error.status < 500) throw error;
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', abort);
              resolve();
            }, 500 * 2 ** attempt);
            controller.signal.addEventListener('abort', abort, { once: true });
          });
        }
      }
    })().finally(() => {
      if (this.pending.get(path)?.controller === controller) this.pending.delete(path);
    });
    this.pending.set(path, { controller, promise });
    return promise;
  }

  cancel(): void {
    const previous = [...this.pending.values()];
    this.pending.clear();
    previous.forEach(({ controller }) => controller.abort());
  }
}
