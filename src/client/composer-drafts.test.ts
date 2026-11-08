import { describe, expect, it } from 'vitest';
import { clearComposerDraftContext, createComposerDrafts, sendTransferredComposerDraft, submittedComposerDraft } from './composer-drafts';
import type { ComposerDocumentAttachment } from './types';

const image = { id: 'image', name: 'example.png', url: 'data:image/png;base64,example' };
const skill = { name: 'example', path: '/skills/example', description: 'Example', enabled: true };
const document: ComposerDocumentAttachment = { id: 'pdf', uploadId: 'pdf', name: 'example.pdf', kind: 'document',
  path: 'C:\\attachments\\example.pdf', url: '/api/files/content?path=example.pdf', size: 1234 };
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

describe('composer drafts', () => {
  it('keeps attachments and skills with their chat across unmounts and isolates other workspaces', () => {
    const drafts = createComposerDrafts();
    const a = drafts.open('a');
    a.update(d => ({ ...d, text: 'Draft A', attachments: [image], skills: [skill] }));
    const b = drafts.open('b');
    b.update(d => ({ ...d, text: 'Draft B' }));
    expect(drafts.open('a').get()).toMatchObject({ text: 'Draft A', attachments: [image], skills: [skill] });
    expect(b.get().attachments).toEqual([]);
    expect(createComposerDrafts().open('a').get().attachments).toEqual([]);
  });

  it('restores text, small images, ready PDFs and selected skills after reload without storing Files', () => {
    const storage = memoryStorage();
    const drafts = createComposerDrafts(storage);
    drafts.open('a').update(d => ({ ...d, text: 'text',
      attachments: [image, { ...document, file: { private: 'must not persist' } as unknown as File }], skills: [skill] }));
    expect(storage.getItem('draft:a')).toBe('text');
    expect(storage.getItem('composer-context:v1')).not.toContain('private');
    const recovered = createComposerDrafts(storage).open('a').get();
    expect(recovered).toMatchObject({ text: 'text', attachments: [{ ...image, kind: 'image' }, document], skills: [skill] });
    expect(recovered.recoveryNotice).toBeUndefined();
    expect(createComposerDrafts(storage).open('other').get().attachments).toEqual([]);
  });

  it('keeps attachments in memory and warns when browser storage is full or blocked', () => {
    const unavailable = createComposerDrafts({
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Quota'); }, removeItem: () => {}
    }).open('a');
    expect(() => unavailable.update(d => ({ ...d, text: 'text', attachments: [image] }))).not.toThrow();
    expect(unavailable.get().attachments).toEqual([image]);
    expect(unavailable.get().recoveryNotice).toBeTruthy();
  });

  it('invalidates stale persisted attachments after a quota failure and retains a small recovery marker', () => {
    const storage = memoryStorage();
    const drafts = createComposerDrafts(storage);
    const owner = drafts.open('a');
    owner.update(d => ({ ...d, attachments: [image] }));
    const originalSet = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === 'composer-context:v1') throw new Error('Quota');
      originalSet(key, value);
    };
    owner.update(d => ({ ...d, attachments: [document] }));
    expect(owner.get().attachments).toEqual([document]);
    expect(storage.getItem('composer-context:v1')).toBeNull();
    const recovered = createComposerDrafts(storage).open('a').get();
    expect(recovered.attachments).toEqual([]);
    expect(recovered.recoveryNotice).toBeTruthy();
  });

  it('reports omitted large images, blob URLs, failed or incomplete uploads and selection overflow', () => {
    const storage = memoryStorage();
    const oversized = { ...image, id: 'large', name: 'large.png', url: `data:image/png;base64,${'A'.repeat(1_100_000)}` };
    const attachments = [image, oversized, { ...image, id: 'blob', name: 'blob.png', url: 'blob:unrecoverable' },
      { ...document, id: 'upload', name: 'upload.pdf', status: 'uploading' as const },
      { ...document, id: 'failed', name: 'failed.pdf', status: 'failed' as const },
      ...Array.from({ length: 16 }, (_, index) => ({ ...image, id: String(index), name: `${index}.png` }))];
    const skills = Array.from({ length: 41 }, (_, index) => ({ ...skill, name: `skill${index}` }));
    const owner = createComposerDrafts(storage).open('a');
    owner.update(d => ({ ...d, attachments, skills }));
    expect(owner.get().attachments).toHaveLength(21);
    expect(owner.get().recoveryNotice).toBeTruthy();
    const recovered = createComposerDrafts(storage).open('a').get();
    expect(recovered.attachments.some(entry => ['large', 'blob', 'upload', 'failed', '15'].includes(entry.id))).toBe(false);
    expect(recovered.skills).toHaveLength(40);
    expect(recovered.recoveryNotice).toContain('skill40');
    expect(recovered.recoveryNotice).toContain('large.png');
  });

  it('bounds the shared store, retaining the active input and warning for evicted conversations', () => {
    const storage = memoryStorage();
    const drafts = createComposerDrafts(storage);
    const bigImage = { ...image, url: `data:image/png;base64,${'A'.repeat(700_000)}` };
    for (let index = 0; index < 35; index++) {
      drafts.open(String(index)).update(d => ({ ...d, attachments: [bigImage] }));
    }
    expect(storage.getItem('composer-context:v1')!.length * 2).toBeLessThanOrEqual(4 * 1024 * 1024);
    const restored = createComposerDrafts(storage);
    expect(restored.open('34').get().attachments).toHaveLength(1);
    expect(restored.open('0').get().recoveryNotice).toBeTruthy();
  });

  it('preserves legacy text-only drafts and clears persisted attachment context on sign-out', () => {
    const storage = memoryStorage();
    storage.setItem('draft:legacy', 'Legacy draft');
    const drafts = createComposerDrafts(storage);
    expect(drafts.open('legacy').get()).toMatchObject({ text: 'Legacy draft', attachments: [], skills: [] });
    expect(drafts.open('legacy').get().recoveryNotice).toBeUndefined();
    drafts.open('a').update(d => ({ ...d, text: 'text', attachments: [image], skills: [skill] }));
    clearComposerDraftContext(storage);
    expect(storage.getItem('composer-context:v1')).toBeNull();
    expect(createComposerDrafts(storage).open('a').get()).toMatchObject({ text: 'text', attachments: [], skills: [] });
  });

  it('rejects damaged, stale and unsafe persisted contexts without breaking text recovery', () => {
    for (const context of [
      '{broken',
      JSON.stringify({ a: { updatedAt: Date.now(), attachments: [{ ...document, url: 'https://evil.example/file' }], skills: [], omitted: [] } }),
      JSON.stringify({ a: { updatedAt: Date.now(), attachments: [{ ...image, url: 'javascript:alert(1)' }], skills: [], omitted: [] } }),
      JSON.stringify({ a: { updatedAt: Date.now(), attachments: [], skills: [{ ...skill, interface: { displayName: {} } }], omitted: [] } }),
      JSON.stringify({ a: { updatedAt: Date.now() - 25 * 60 * 60_000, attachments: [image], skills: [], omitted: [] } }),
      JSON.stringify({ a: { updatedAt: Date.now() + 60 * 60_000, attachments: [image], skills: [], omitted: [] } })
    ]) {
      const storage = memoryStorage();
      storage.setItem('draft:a', 'Preserved');
      storage.setItem('composer-context:v1', context);
      const recovered = createComposerDrafts(storage).open('a').get();
      expect(recovered.text).toBe('Preserved');
      expect(recovered.attachments).toEqual([]);
      expect(recovered.skills).toEqual([]);
      expect(recovered.recoveryNotice).toBeTruthy();
    }
  });

  it('routes a late file read to its original chat even after reopening it', async () => {
    const drafts = createComposerDrafts();
    const original = drafts.open('a');
    const append = Promise.resolve(image).then(image => original.update(d => ({ ...d, attachments: [...d.attachments, image] })));
    const reopened = drafts.open('a');
    const other = drafts.open('b');
    await append;
    expect(reopened.get().attachments).toEqual([image]);
    expect(other.get().attachments).toEqual([]);
  });

  it('retains a pending send across remounts and clears only submitted input on success', () => {
    const drafts = createComposerDrafts();
    const a = drafts.open('a', { text: 'Original ', attachments: [image], skills: [skill] });
    const submitted = a.get();
    a.update(d => ({ ...d, sending: true }));
    const reopened = drafts.open('a');
    expect(reopened.get().sending).toBe(true);
    const extra = { ...image, id: 'second' };
    reopened.update(d => ({ ...d, text: 'New draft', attachments: [...d.attachments, extra] }));
    a.update(d => ({ ...submittedComposerDraft(d, submitted), sending: false }));
    expect(reopened.get()).toEqual({ text: 'New draft', attachments: [extra], skills: [], sending: false });
  });

  it('keeps failed submissions and does not reuse cleared initial side-chat input', () => {
    const drafts = createComposerDrafts();
    const a = drafts.open('a', { text: 'Queued', attachments: [image], skills: [] });
    a.update(d => ({ ...d, sending: true }));
    a.update(d => ({ ...d, sending: false }));
    expect(a.get().attachments).toEqual([image]);
    a.update(d => submittedComposerDraft(d, d));
    expect(drafts.open('a', { text: 'Queued', attachments: [image], skills: [] }).get())
      .toEqual({ text: '', attachments: [], skills: [], sending: false });
  });

  it('moves pending home input into its newly created chat and recovers it there after a failed first send', async () => {
    const storage = memoryStorage();
    const drafts = createComposerDrafts(storage);
    const home = drafts.open('home');
    home.update(current => ({ ...current, text: ' Start a task ', attachments: [image, document], skills: [skill] }));
    const submitted = home.get();
    home.update(current => ({ ...current, sending: true }));
    let rejectSend!: (error: Error) => void;
    const send = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    const pending = sendTransferredComposerDraft(drafts, 'home', 'new-thread', submitted, () => send);
    expect(drafts.open('new-thread').get()).toMatchObject({ text: submitted.text,
      attachments: [image, document], skills: [skill], sending: true });
    expect(home.get()).toMatchObject({ text: '', attachments: [], skills: [], sending: false });
    rejectSend(new Error('Disconnected'));
    await expect(pending).rejects.toThrow('Disconnected');
    expect(drafts.open('new-thread').get()).toMatchObject({ text: submitted.text,
      attachments: [image, document], skills: [skill], sending: false });
    const reloaded = createComposerDrafts(storage);
    expect(reloaded.open('new-thread').get()).toMatchObject({ text: submitted.text,
      attachments: [{ ...image, kind: 'image' }, document], skills: [skill] });
    expect(reloaded.open('home').get()).toMatchObject({ text: '', attachments: [], skills: [] });
  });

  it('clears only transferred input after success while preserving later edits at home and in the new chat', async () => {
    const drafts = createComposerDrafts();
    const home = drafts.open('home', { text: 'First send', attachments: [image], skills: [skill] });
    const submitted = home.get();
    const laterImage = { ...image, id: 'later' };
    home.update(current => ({ ...current, text: 'Next home draft', attachments: [...current.attachments, laterImage] }));
    let resolveSend!: () => void;
    const pending = sendTransferredComposerDraft(drafts, 'home', 'new-thread', submitted,
      () => new Promise<void>(resolve => { resolveSend = resolve; }));
    expect(home.get()).toMatchObject({ text: 'Next home draft', attachments: [laterImage], skills: [] });
    drafts.open('new-thread').update(current => ({ ...current, text: 'Follow-up', attachments: [...current.attachments, document] }));
    resolveSend(); await pending;
    expect(drafts.open('new-thread').get()).toEqual({ text: 'Follow-up', attachments: [document], skills: [], sending: false });
    expect(home.get()).toMatchObject({ text: 'Next home draft', attachments: [laterImage] });
  });

  it('clears an unchanged successful home handoff and preserves an independently typed destination draft', async () => {
    const drafts = createComposerDrafts();
    const submitted = { text: 'First send', attachments: [image], skills: [skill] };
    drafts.open('home', submitted);
    await sendTransferredComposerDraft(drafts, 'home', 'new-thread', submitted, async () => {});
    expect(drafts.open('new-thread').get()).toEqual({ text: '', attachments: [], skills: [], sending: false });
    drafts.open('home').update(current => ({ ...current, ...submitted }));
    drafts.open('new-thread').update(current => ({ ...current, text: 'Destination note', attachments: [document] }));
    await sendTransferredComposerDraft(drafts, 'home', 'new-thread', submitted, async () => {});
    expect(drafts.open('new-thread').get()).toEqual({ text: 'Destination note', attachments: [document], skills: [], sending: false });
  });
});
