import { List, LoaderCircle, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { memo, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { OutlineTurn } from '../../shared/thread-outline';
import { itemKey } from '../remote-state';

export interface NavigationTarget {
  turnId: string;
  itemId: string;
}

interface Props {
  turns: OutlineTurn[];
  streamRef: RefObject<HTMLDivElement | null>;
  innerRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  error: string | null;
  onNavigate: (target: NavigationTarget) => void;
}

export const ThreadNavigation = memo(function ThreadNavigation({ turns, streamRef, innerRef, busy, error, onNavigate }: Props) {
  const entries = useMemo(() => turns.flatMap(turn => turn.messages.map(message =>
    ({ ...message, turnId: turn.id, key: itemKey({ id: message.itemId, turnId: turn.id }) }))), [turns]);
  const [current, setCurrent] = useState('');
  const [hovered, setHovered] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ index: number; x: number; y: number } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileTriggerTarget, setMobileTriggerTarget] = useState<HTMLElement | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const mobileRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const previewId = useId();

  useEffect(() => {
    setMobileTriggerTarget(streamRef.current?.closest('.thread-screen')
      ?.querySelector<HTMLElement>('[data-thread-navigation-slot]') ?? null);
  }, []);

  useEffect(() => {
    const stream = streamRef.current;
    const inner = innerRef.current;
    if (!stream || !inner) return;
    let frame = 0;
    let needsMeasure = true;
    let anchors: Array<{ key: string; top: number }> = [];
    const measure = () => {
      const origin = stream.getBoundingClientRect().top - stream.scrollTop;
      anchors = [...inner.querySelectorAll<HTMLElement>('[data-user-key]')].map(node =>
        ({ key: node.dataset.userKey!, top: node.getBoundingClientRect().top - origin }));
      // A bounded page may start inside an assistant response.
      const first = inner.querySelector<HTMLElement>('[data-turn-id]');
      if (first && (!anchors.length || anchors[0]!.top > first.getBoundingClientRect().top - origin)) {
        const entry = [...entries].reverse().find(entry => entry.turnId === first.dataset.turnId);
        if (entry) anchors.unshift({ key: entry.key, top: first.getBoundingClientRect().top - origin });
      }
      update();
    };
    const update = () => {
      const position = stream.scrollTop + Math.min(120, stream.clientHeight * .22);
      let low = 0, high = anchors.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (anchors[middle]!.top <= position) low = middle + 1;
        else high = middle;
      }
      const anchor = anchors[Math.max(0, low - 1)];
      if (anchor) setCurrent(value => value === anchor.key ? value : anchor.key);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (needsMeasure) { needsMeasure = false; measure(); }
        else update();
      });
    };
    const changed = () => { needsMeasure = true; schedule(); };
    const observer = new ResizeObserver(changed);
    const mutations = new MutationObserver(changed);
    observer.observe(inner);
    mutations.observe(inner, { childList: true, subtree: true });
    stream.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); stream.removeEventListener('scroll', schedule); };
  }, [entries, innerRef, streamRef]);

  useEffect(() => {
    const active = buttonsRef.current.find(button => button?.dataset.key === current);
    const rail = railRef.current;
    if (!active || !rail) return;
    if (rail.matches(':hover') || rail.contains(document.activeElement)) return;
    if (active.offsetTop < rail.scrollTop || active.offsetTop + active.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = active.offsetTop - rail.clientHeight / 2;
    }
  }, [current]);

  useEffect(() => {
    if (!mobileOpen) { mobileRef.current?.close(); return; }
    mobileRef.current?.showModal();
    // Keep the first control from receiving an opening-time focus ring.
    // Keyboard navigation still gives each button its normal visible focus.
    mobileRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      mobileRef.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [mobileOpen]);

  const showPreview = (index: number, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setHovered(index);
    setPreview({ index, x: rect.right + 10, y: Math.max(12, Math.min(rect.top - 28, window.innerHeight - 150)) });
  };
  const navigate = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    setPreview(null);
    setHovered(null);
    setMobileOpen(false);
    onNavigate(entry);
  };
  if (!entries.length) return null;
  const previewEntry = preview ? entries[preview.index] : null;
  return <>
    <nav className="thread-navigation" aria-label="对话回合" aria-busy={busy}>
      <div className="thread-navigation-rail" ref={railRef} onMouseLeave={() => { setHovered(null); setPreview(null); }}
        onScroll={() => setPreview(null)}>
        {entries.map((entry, index) => <button type="button" key={entry.key}
          ref={node => { buttonsRef.current[index] = node; }} data-key={entry.key}
          className={`thread-navigation-mark${entry.key === current ? ' is-current' : ''}`}
          style={{ '--mark-width': hovered === null ? undefined : `${Math.max(8, 32 - Math.abs(index - hovered) * 7)}px` } as React.CSSProperties}
          aria-label={`第 ${index + 1} 轮：${entry.prompt.slice(0, 80)}`}
          aria-current={entry.key === current ? 'location' : undefined}
          tabIndex={entry.key === current || !current && index === 0 ? 0 : -1}
          aria-describedby={preview?.index === index ? previewId : undefined}
          onMouseEnter={event => showPreview(index, event.currentTarget)}
          onFocus={event => showPreview(index, event.currentTarget)}
          onBlur={() => { setHovered(null); setPreview(null); }}
          onClick={() => navigate(index)}
          onKeyDown={event => {
            if (event.key === 'Escape') { setHovered(null); setPreview(null); return; }
            const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1
              : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null;
            if (next !== null) { event.preventDefault(); buttonsRef.current[Math.max(0, Math.min(entries.length - 1, next))]?.focus(); }
          }}><span /></button>)}
      </div>
      {busy && <LoaderCircle className="spin navigation-loading" size={13} aria-label="正在定位" />}
    </nav>
    {previewEntry && preview && createPortal(<div id={previewId} role="tooltip" className="thread-navigation-preview"
      style={{ left: preview.x, top: preview.y }}>
      <div className="navigation-prompt">{previewEntry.prompt}</div>
      {previewEntry.reply && <div className="navigation-reply">{previewEntry.reply}</div>}
    </div>, document.body)}
    {(() => {
      const trigger = <button type="button" ref={triggerRef}
        className={`thread-navigation-mobile icon-button composer-circle-button${mobileTriggerTarget ? ' thread-navigation-mobile--composer' : ''}`}
        aria-label="对话回合" aria-haspopup="dialog" aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(true)}>
        {busy ? <LoaderCircle size={17} className="spin" /> : <List size={18} />}
      </button>;
      return mobileTriggerTarget ? createPortal(trigger, mobileTriggerTarget) : trigger;
    })()}
    <dialog ref={mobileRef} className="thread-navigation-dialog" aria-label="对话回合" tabIndex={-1}
      onCancel={() => setMobileOpen(false)}
      onClose={() => { setMobileOpen(false); triggerRef.current?.focus(); }}
      onClick={event => { if (event.target === event.currentTarget) setMobileOpen(false); }}>
      <div className="navigation-dialog-header"><span>对话回合</span>
        <button type="button" className="icon-button navigation-dialog-close" aria-label="关闭" onClick={() => setMobileOpen(false)}><X size={18} /></button>
      </div>
      {error && <p className="navigation-error" role="status">部分回合未能加载，请重新打开会话。</p>}
      <div className="navigation-dialog-list">{entries.map((entry, index) =>
        <button type="button" key={entry.key} aria-current={entry.key === current ? 'location' : undefined}
          onClick={() => navigate(index)}>
          <span className="navigation-index">{index + 1}</span>
          <span><span className="navigation-prompt">{entry.prompt}</span>
            {entry.reply && <span className="navigation-reply">{entry.reply}</span>}</span>
        </button>)}</div>
    </dialog>
  </>;
});
