import type { NativeTurnError } from '../shared/native-error';

// Desktop projects retry progress from this native message, not a local counter.
export function nativeErrorContent(error: NativeTurnError, retrying: boolean): string {
  if (retrying) {
    const progress = /^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/.exec(error.message.trim());
    const overloaded = error.codexErrorInfo === 'serverOverloaded' ||
      typeof error.codexErrorInfo === 'object' &&
      error.codexErrorInfo?.responseStreamDisconnected?.httpStatusCode === 429;
    if (overloaded) return `服务器繁忙，正在重新连接${progress ? ` ${progress[1]}/${progress[2]}` : ''}`;
    return progress ? `正在重新连接 ${progress[1]}/${progress[2]}` : error.message;
  }
  const start = error.message.indexOf('{'), end = error.message.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const envelope: unknown = JSON.parse(error.message.slice(start, end + 1));
      if (envelope && typeof envelope === 'object' && 'error' in envelope) {
        const inner = envelope.error;
        if (inner && typeof inner === 'object' && 'message' in inner && typeof inner.message === 'string')
          return inner.message;
      }
    } catch { /* Non-JSON native errors retain their original message. */ }
  }
  return error.message;
}
