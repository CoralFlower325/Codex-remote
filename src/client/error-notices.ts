import { useCallback, useRef, useState, type SetStateAction } from 'react';

export function useErrorNotices() {
  const [errors, setErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [lastError, updateLastError] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  const notices = useRef(errors);
  notices.current = errors;
  const sequence = useRef(0);
  const setLastError = useCallback((update: SetStateAction<string | null>) => {
    const message = typeof update === 'function' ? update(latest.current) : update;
    latest.current = message;
    updateLastError(message);
    if (!message) return;
    setErrors(current => current.some(error => error.message === message) ? current :
      [...current.slice(-7), { id: String(++sequence.current), message }]);
  }, []);
  const dismissError = useCallback((id: string) => {
    const removed = notices.current.find(error => error.id === id);
    if (removed?.message === latest.current) { latest.current = null; updateLastError(null); }
    setErrors(current => current.filter(error => error.id !== id));
  }, []);
  const resolveError = useCallback((message: string | null) => {
    if (!message) return;
    if (latest.current === message) { latest.current = null; updateLastError(null); }
    setErrors(current => current.filter(error => error.message !== message));
  }, []);
  return { errors, lastError, setLastError, dismissError, resolveError };
}
