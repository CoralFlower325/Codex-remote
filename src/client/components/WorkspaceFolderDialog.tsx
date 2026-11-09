import { ArrowUp, Folder, FolderPlus, LoaderCircle, X, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import type { ChatTransport } from '../chat-transport';
import type { ProjectInfo } from '../types';

export function WorkspaceFolderDialog({ projects, connected, transport, initialCwd, refreshProjects, onSelect, onClose }: {
  projects: ProjectInfo[];
  connected: boolean;
  transport: ChatTransport;
  initialCwd?: string | undefined;
  refreshProjects: () => Promise<void>;
  onSelect: (projectId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initialCwd || projects[0]?.roots[0]?.path || '');
  const [current, setCurrent] = useState(path);
  const [folders, setFolders] = useState<string[]>([]);
  const [newName, setNewName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creationKey = useRef(randomUUID());
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  useEffect(() => {
    if (!current || !connected) return;
    let disposed = false;
    setLoading(true); setError(null);
    void transport.rpc<{ entries: Array<{ fileName: string; isDirectory: boolean }> }>(
      'fs/readDirectory', { path: current }).then(result => {
        if (!disposed) { setPath(current); setFolders(result.entries.filter(entry => entry.isDirectory).map(entry => entry.fileName).sort()); }
      }).catch(error => { if (!disposed) setError(error.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [current, connected, transport]);
  const join = (parent: string, name: string) => `${parent.replace(/[\\/]$/, '')}${parent.includes('\\') || /^[a-z]:/i.test(parent) ? '\\' : '/'}${name}`;
  return <dialog ref={dialogRef} className="workspace-folder-dialog" aria-label="添加工作区" onClose={onClose}>
    <header><strong>添加工作区</strong><button type="button" className="icon-button" aria-label="关闭工作区选择" onClick={() => dialogRef.current?.close()}><X size={18} /></button></header>
    <form className="folder-path" onSubmit={event => { event.preventDefault(); setCurrent(path.trim()); }}>
      <button type="button" className="icon-button" title="上一级" aria-label="上一级" disabled={saving || loading || !current}
        onClick={() => {
          const cleaned = current.replace(/[\\/]$/, '');
          const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
          if (index >= 0) { const parent = cleaned.slice(0, index + 1); setCurrent(parent); setPath(parent); }
        }}><ArrowUp size={16} /></button>
      <input aria-label="工作区文件夹路径" value={path} disabled={saving} onChange={event => setPath(event.target.value)} placeholder="文件夹路径" />
      <button type="submit" className="icon-button" aria-label="打开文件夹路径" title="打开文件夹路径" disabled={!path.trim() || saving}><Check size={16} /></button>
    </form>
    <div className="folder-list" aria-busy={loading}>
      {loading ? <LoaderCircle size={20} className="spin" /> : folders.map(name => <button type="button" key={name} disabled={saving}
        onClick={() => setCurrent(join(current, name))}><Folder size={17} /><span>{name}</span></button>)}
      {!loading && !folders.length && !error && <p>此文件夹中没有子文件夹</p>}
    </div>
    {newName !== null && <form className="folder-create" onSubmit={async event => {
      event.preventDefault();
      if (!newName.trim() || /[\\/:*?"<>|]/.test(newName) || ['.', '..'].includes(newName.trim())) { setError('请输入有效的文件夹名称。'); return; }
      setSaving(true); setError(null);
      try {
        const destination = join(current, newName.trim());
        await transport.rpc('fs/createDirectory', { path: destination, recursive: false });
        setCurrent(destination); setPath(destination); setNewName(null);
      } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setSaving(false); }
    }}>
      <input autoFocus value={newName} aria-label="新文件夹名称" placeholder="文件夹名称" disabled={saving} onChange={event => setNewName(event.target.value)} />
      <button type="submit" className="icon-button" aria-label="创建文件夹" title="创建文件夹" disabled={saving}><Check size={16} /></button>
      <button type="button" className="icon-button" aria-label="取消新建文件夹" onClick={() => setNewName(null)}><X size={16} /></button>
    </form>}
    {error && <p className="folder-error" role="alert">{error}</p>}
    <footer>
      <button type="button" className="folder-new-button" onClick={() => setNewName('')} disabled={!current || loading || saving}>
        <FolderPlus size={16} />新建文件夹</button>
      <button type="button" className="folder-add-button" disabled={!current || loading || saving || Boolean(error)} onClick={async () => {
        setSaving(true); setError(null);
        try {
          const existing = projects.find(project => project.roots.some(root => root.path === current));
          const project = existing ?? (await transport.rpc<{ project: ProjectInfo }>('project/create', {
            idempotencyKey: creationKey.current,
            name: current.replace(/[\\/]$/, '').split(/[\\/]/).pop() || current, roots: [{ path: current }]
          })).project;
          await refreshProjects();
          onSelect(project.id); dialogRef.current?.close();
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setSaving(false); }
      }}>{saving ? <LoaderCircle size={15} className="spin" /> : null}添加工作区</button>
    </footer>
  </dialog>;
}
