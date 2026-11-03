import { Check, Copy } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import { middleTruncate } from '../middle-truncate';
import './path-text.css';

export function PathText({ value, label = value }: { value: string; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [display, setDisplay] = useState(label);
  useLayoutEffect(() => {
    const element = ref.current!;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) { setDisplay(label); return; }
    let frame = 0;
    const update = () => {
      const style = getComputedStyle(element);
      // The font shorthand can be empty when inherited variant settings cannot be serialized.
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      setDisplay(middleTruncate(label, Math.max(0, element.clientWidth - 2), text => context.measureText(text).width));
    };
    update();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [label]);
  return <code ref={ref} className="path-text" title={value} aria-label={value}>{display}</code>;
}

export function CopyPathButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setCopied(false); setError('');
  }, [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return <>
    <button type="button" className="icon-button path-copy" title={error || (copied ? '已复制路径' : `复制路径：${value}`)}
      aria-label={`复制路径：${value}`} onClick={event => {
        event.stopPropagation();
        void copyText(value).then(() => { setCopied(true); setError(''); })
          .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
      }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    {copied && <span className="sr-only" role="status">已复制路径</span>}
    {error && <span className="path-copy-error" role="alert">{error}</span>}
  </>;
}
