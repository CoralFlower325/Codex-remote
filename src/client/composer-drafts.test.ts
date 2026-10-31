import { describe, expect, it } from 'vitest';
import { createComposerDrafts, submittedComposerDraft } from './composer-drafts';

const image = { id: 'image', name: 'example.png', url: 'data:image/png;base64,example' };
const skill = { name: 'example', path: '/skills/example', description: 'Example', enabled: true };

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

  it('stores only text and keeps images usable when browser storage is full or blocked', () => {
    const persisted = new Map<string, string>();
    const drafts = createComposerDrafts({
      getItem: key => persisted.get(key) ?? null,
      setItem: (key, value) => { persisted.set(key, value); },
      removeItem: key => { persisted.delete(key); }
    });
    drafts.open('a').update(d => ({ ...d, text: 'text', attachments: [image], skills: [skill] }));
    expect([...persisted]).toEqual([['draft:a', 'text']]);
    const unavailable = createComposerDrafts({
      getItem: () => { throw new Error('Blocked'); },
      setItem: () => { throw new Error('Quota'); }, removeItem: () => {}
    }).open('a');
    expect(() => unavailable.update(d => ({ ...d, text: 'text', attachments: [image] }))).not.toThrow();
    expect(unavailable.get().attachments).toEqual([image]);
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
});
