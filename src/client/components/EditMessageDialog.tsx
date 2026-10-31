import { Copy, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MessageEditError, messageEditText, type UserMessage } from '../message-edit';
import { copyText } from '../clipboard';

export function EditMessageDialog({ item, threadId, disabled, onSubmit, onClose }: {
  item: UserMessage; threadId: string; disabled: boolean;
  onSubmit: (text: string) => Promise<void>; onClose: () => void;
}) {
  const key = `edit-draft:${threadId}:${item.id}`;
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const [text, setText] = useState(() => sessionStorage.getItem(key) ?? messageEditText(item));
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    editor.current?.focus();
  }, []);
  return <dialog ref={dialog} className="command-dialog message-edit-dialog" aria-labelledby="message-edit-title"
    onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}>
    <div className="command-dialog-head">
      <h2 id="message-edit-title">编辑消息</h2>
      <button type="button" className="icon-button" aria-label="关闭编辑" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form className="command-dialog-body command-review-form" onSubmit={event => {
      event.preventDefault();
      if (submitting.current || disabled || uncertain) return;
      submitting.current = true; setBusy(true); setError('');
      sessionStorage.setItem(key, text);
      void onSubmit(text).then(() => { sessionStorage.removeItem(key); onClose(); })
        .catch((failure: unknown) => {
          setUncertain(failure instanceof MessageEditError && failure.uncertain);
          setError(failure instanceof Error ? failure.message : String(failure));
        }).finally(() => { submitting.current = false; setBusy(false); });
    }}>
      <label className="sr-only" htmlFor="message-edit-text">消息内容</label>
      <textarea ref={editor} id="message-edit-text" aria-describedby="message-edit-note" rows={6} value={text} disabled={busy} onChange={event => {
        setText(event.target.value); sessionStorage.setItem(key, event.target.value);
      }} />
      <p id="message-edit-note" className="message-edit-note">重新发送将替换此轮及后续对话，保留原消息附件和技能。已执行的文件修改不会撤销。</p>
      {error && <p className="command-dialog-error" role="alert">{error}</p>}
      <div className="message-edit-actions">
        {uncertain && <button type="button" className="secondary-button" title="复制修改内容" onClick={() => {
          void copyText(text).catch(failure => setError(String(failure)));
        }}><Copy size={15} />复制内容</button>}
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={busy || disabled || uncertain ||
          (!text.trim() && !item.content.some(part => part.type !== 'text'))}>
          {busy && <LoaderCircle size={15} className="spin" />}保存并重新发送
        </button>
      </div>
    </form>
  </dialog>;
}
