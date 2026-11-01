import { ArrowUpRight, Download, ImageOff, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function ImagePreview({ src, alt = '' }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [longImage, setLongImage] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { setFailed(false); setLongImage(false); setRevision(0); }, [src]);
  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);
  return (
    <>
      <button type="button" className={`image-thumbnail${longImage ? ' image-thumbnail--long' : ''}`} aria-label={failed ? '图片不可用，点击重试' : alt ? `查看图片：${alt}` : '查看图片'}
        title={failed ? '图片不可用，点击重试' : alt || '查看图片'}
        onClick={() => { if (failed) { setFailed(false); setRevision(value => value + 1); } else setOpen(true); }}>
        {failed ? <span className="image-unavailable"><ImageOff size={20} /><RefreshCw size={12} /></span>
          : <img key={`${src}:${revision}`} src={src} alt={alt} loading="lazy" decoding="async"
            onLoad={event => setLongImage(event.currentTarget.naturalHeight > event.currentTarget.naturalWidth * 2)}
            onError={() => setFailed(true)} />}
        {longImage && !failed && <span className="image-thumbnail-label" aria-hidden="true">长图</span>}
      </button>
      {open && createPortal(
        <dialog ref={dialogRef} className={`image-viewer${longImage ? ' image-viewer--long' : ''}`} aria-label="图片预览"
          onClose={() => setOpen(false)} onClick={(event) => {
            if (event.target === event.currentTarget) dialogRef.current?.close();
          }}>
          <div className="image-viewer-toolbar">
            <span>{alt || '图片'}</span>
            <a className="icon-button" href={src} target="_blank" rel="noreferrer" aria-label="打开原图" title="打开原图"><ArrowUpRight size={18} /></a>
            <a className="icon-button" href={src} download aria-label="下载图片" title="下载图片"><Download size={18} /></a>
            <button type="button" className="icon-button" aria-label="关闭图片预览" title="关闭图片预览"
              onClick={() => dialogRef.current?.close()}><X size={18} /></button>
          </div>
          <div className="image-viewer-stage"><img src={src} alt={alt} /></div>
        </dialog>,
        document.body
      )}
    </>
  );
}
