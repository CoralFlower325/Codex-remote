import { Command, LoaderCircle, Sparkles, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SlashOption } from '../slash-commands';

export function SlashMenu({ id, options, index, skillsOnly, loading, error, anchor, layout, onSelect, onIndex, onClose }: {
  id: string;
  options: SlashOption[];
  index: number;
  skillsOnly: boolean;
  loading: boolean;
  error: string | null;
  anchor: RefObject<HTMLDivElement | null>;
  layout: 'desktop' | 'mobile';
  onSelect: (option: SlashOption) => void;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const available = Math.max(160, rect.top - viewportTop - 8);
      setStyle({
        left: layout === 'mobile' ? 12 : Math.max(8, rect.left),
        ...(layout === 'mobile' ? { right: 12, width: 'auto' } : {
          width: Math.min(440, rect.width, window.innerWidth - 16)
        }),
        bottom: window.innerHeight - rect.top + 6,
        maxHeight: layout === 'mobile'
          ? Math.min(360, viewportHeight * .48, available)
          : Math.min(360, available)
      });
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [anchor, layout]);
  useEffect(() => {
    document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, index]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [anchor, onClose]);
  return createPortal(
    <>
      {layout === 'mobile' && <button type="button" className="slash-menu-backdrop"
        aria-label="关闭命令菜单" onClick={onClose} tabIndex={-1} />}
    <div className={`slash-menu${layout === 'mobile' ? ' slash-menu--mobile' : ''}`}
      style={style} ref={root} onMouseDown={(event) => event.preventDefault()}>
      <div className="slash-menu-heading">
        <span>{skillsOnly ? '技能' : '命令与技能'}</span>
        {loading && <LoaderCircle size={13} className="spin" aria-label="正在读取技能" />}
        <button type="button" className="icon-button icon-button--small" tabIndex={-1}
          title="关闭命令菜单" aria-label="关闭命令菜单" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="slash-menu-options" id={id} role="listbox" aria-label={skillsOnly ? '可用技能' : '斜杠命令'}>
        {options.map((option, optionIndex) => (
          <button type="button" role="option" id={`${id}-${optionIndex}`} key={option.id} tabIndex={-1}
            aria-selected={optionIndex === index} disabled={Boolean(option.disabledReason)}
            title={option.disabledReason || option.description}
            onMouseMove={() => { if (!option.disabledReason) onIndex(optionIndex); }}
            onClick={() => onSelect(option)}>
            {option.skill ? <Sparkles size={16} /> : <Command size={16} />}
            <span className="slash-option-copy"><strong>{option.label}</strong>
              <span>{option.description}</span></span>
          </button>
        ))}
        {!options.length && <p className="slash-menu-empty">{skillsOnly ? loading ? '正在读取技能…' : '没有匹配的已启用技能' : '没有匹配的命令或技能'}</p>}
      </div>
      {error && <div className="slash-menu-error" role="status">{error}</div>}
    </div>
    </>,
    document.body
  );
}
