import { historyConfig } from '../history-config';
import { Check, CornerDownRight, ListEnd, MoreHorizontal, Pencil, MessageCirclePlus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatTransport } from '../chat-transport';
import { queuedDraft, replaceQueuedText, type ChatInput, type QueuedSubmission } from '../queued-messages';
import { api, isAbortedRequest } from '../api';

export function QueuedMessages({ transport, threadId, activeTurnId, connected, readable, onError, onOpenSideChat,
  queueEnabled, onQueueEnabledChange }: {
  transport: ChatTransport;
  threadId: string;
  activeTurnId: string | null;
  connected: boolean;
  readable: boolean;
  onError: (error: unknown) => void;
  onOpenSideChat: (input: ChatInput) => void;
  queueEnabled: boolean;
  onQueueEnabledChange: (enabled: boolean) => void;
}) {
  const [messages, setMessages] = useState<QueuedSubmission[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<{ id: string; top: number; right: number } | null>(null);
  const version = useRef(0);
  const turnRef = useRef(activeTurnId);
  turnRef.current = activeTurnId;

  useEffect(() => {
    if (!readable) { setMessages([]); return; }
    let disposed = false;
    const controller = new AbortController();
    const refresh = async () => {
      const startedAt = performance.now();
      console.debug('[thread-dock] queue read started');
      const request = ++version.current;
      const collected: QueuedSubmission[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page: { data: QueuedSubmission[]; nextCursor?: string | null } = await api(
          `/api/thread/dock/queue?${new URLSearchParams({ threadId, ...(cursor ? { cursor } : {}) })}`,
          { cache: 'no-store', signal: controller.signal, timeoutMs: historyConfig.readTimeoutMs });
        if (disposed || request !== version.current) return;
        if (!Array.isArray(page.data) || page.data.some(message => !message || typeof message.id !== 'string' ||
            typeof message.clientUserMessageId !== 'string' || !Array.isArray(message.input)) ||
            page.nextCursor != null && typeof page.nextCursor !== 'string') throw new Error('Invalid queued message response.');
        collected.push(...page.data);
        if (!disposed && request === version.current) setMessages([...collected]);
        cursor = page.nextCursor ?? null;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated queued message cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      console.debug('[thread-dock] queue read finished', { elapsedMs: performance.now() - startedAt, count: collected.length });
      if (!disposed && request === version.current) setMessages(collected);
    };
    const load = () => { void refresh().catch(error => { if (!disposed && !isAbortedRequest(error)) onError(error); }); };
    load();
    const unsubscribe = transport.subscribe((method, params) => {
      if (params.threadId === threadId && ['thread/queue/changed', 'turn/started', 'turn/completed'].includes(method)) load();
    });
    return () => { disposed = true; controller.abort(); version.current++; unsubscribe(); };
  }, [readable, connected, threadId, transport]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener('resize', close);
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('keydown', keydown, true); };
  }, [menu]);

  async function act(message: QueuedSubmission, action: 'send' | 'delete' | 'save' | 'side') {
    if (busy || !connected) return;
    setBusy(message.id);
    setMenu(null);
    try {
      if (action === 'save') {
        await transport.rpc('thread/queue/update', {
          threadId, queuedSubmissionId: message.id, input: replaceQueuedText(message.input, text)
        });
        setEditing(null);
      } else {
        if (action === 'send') {
          const turnId = turnRef.current;
          if (turnId) await transport.rpc('turn/steer', {
            threadId, expectedTurnId: turnId, input: message.input,
            clientUserMessageId: message.clientUserMessageId
          });
          else await transport.rpc('thread/queue/start', { threadId, queuedSubmissionId: message.id });
          if (!turnId) return;
        }
        if (action === 'side') onOpenSideChat(message.input);
        const result = await transport.rpc<{ deleted: boolean }>('thread/queue/delete', { threadId, queuedSubmissionId: message.id });
        if (!result.deleted) throw new Error('待发消息已发生变化，请检查当前队列。');
        setMessages(current => current.filter(entry => entry.id !== message.id));
      }
    } catch (error) { onError(error); }
    finally { setBusy(null); }
  }

  if (!messages.length) return null;
  return <div className="queued-messages" aria-label="待发消息">
    {messages.map(message => <div className="queued-message" key={message.id}>
      {editing === message.id ? <form className="queued-edit" onSubmit={event => { event.preventDefault(); void act(message, 'save'); }}>
        <textarea aria-label="编辑待发消息" value={text} autoFocus onChange={event => setText(event.target.value)} />
        <button className="icon-button" type="submit" aria-label="保存待发消息" disabled={!connected || Boolean(busy)}><Check size={15} /></button>
        <button className="icon-button" type="button" aria-label="取消编辑" onClick={() => setEditing(null)}><X size={15} /></button>
      </form> : <>
        <ListEnd size={15} aria-hidden="true" />
        <span className="queued-message-text" title={queuedDraft(message.input).text}>{queuedDraft(message.input).text ||
          queuedDraft(message.input).attachments.find(attachment => attachment.kind === 'document')?.name || '附件或技能'}</span>
        <button type="button" className="queued-steer" disabled={!connected || Boolean(busy)}
          onClick={() => void act(message, 'send')}><CornerDownRight size={14} />{activeTurnId ? '引导' : '发送'}</button>
        <button type="button" className="icon-button" aria-label="删除待发消息" title="删除待发消息"
          disabled={!connected || Boolean(busy)} onClick={() => void act(message, 'delete')}><Trash2 size={14} /></button>
        <button type="button" className="icon-button" aria-label="待发消息操作" title="待发消息操作"
          aria-haspopup="menu" aria-expanded={menu?.id === message.id} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ id: message.id, top: Math.max(8, rect.top - 130), right: Math.max(8, innerWidth - rect.right) });
          }}><MoreHorizontal size={17} /></button>
      </>}
    </div>)}
    {menu && createPortal(<>
      <button type="button" className="queue-menu-backdrop" aria-label="关闭待发消息菜单" onClick={() => setMenu(null)} />
      <div className="queue-menu" role="menu" style={{ top: menu.top, right: menu.right }}>
        <button type="button" role="menuitem" onClick={() => {
          const message = messages.find(entry => entry.id === menu.id);
          if (message) { setEditing(message.id); setText(queuedDraft(message.input).text); }
          setMenu(null);
        }}><Pencil size={15} />编辑消息</button>
        <button type="button" role="menuitem" disabled={!connected || Boolean(busy)} onClick={() => {
          const message = messages.find(entry => entry.id === menu.id);
          if (message) void act(message, 'side');
        }}><MessageCirclePlus size={15} />在侧边聊天中打开</button>
        <button type="button" role="menuitem" onClick={() => {
          onQueueEnabledChange(!queueEnabled);
          setMenu(null);
        }}><ListEnd size={15} />{queueEnabled ? '关闭排队' : '开启排队'}</button>
      </div>
    </>, document.body)}
  </div>;
}
