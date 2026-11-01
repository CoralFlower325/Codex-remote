import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadDocument, retainDocuments } from './document-attachments';
import { withDocumentReferences, documentReferences } from '../shared/document-input';
import { userMessageText } from '../shared/user-message';
import { turnInput } from './slash-commands';
import { queuedDraft, replaceQueuedText } from './queued-messages';
import { editedMessageInput } from './message-edit';
import { createComposerDrafts } from './composer-drafts';
import { MessageItem } from './components/TurnResponse';
import type { ComposerAttachment } from './types';

const document = { name: 'Report.pdf', path: '/private/document-attachments/upload/Report.pdf' };
const attachment = { ...document, id: 'upload', kind: 'document' as const, url: '/private-preview' };
afterEach(() => vi.unstubAllGlobals());

describe('PDF inputs', () => {
  it('uses the native file context with literal prose, independent image and skill inputs', () => {
    const skill = { name: 'review', path: '/skills/review/SKILL.md', description: '', enabled: true };
    const input = turnInput('Review **this**', [attachment, { url: 'image' }], [skill]);
    expect(input).toEqual([
      { type: 'text', text: withDocumentReferences('[$review](/skills/review/SKILL.md) Review **this**', [document]), text_elements: [] },
      { type: 'image', url: 'image' }, { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }
    ]);
    expect(documentReferences(input)).toEqual([document]);
    expect(userMessageText((input[0] as { text: string }).text)).toContain('Review **this**');
    expect(() => turnInput('Wait', [{ ...attachment, status: 'uploading' }])).toThrow('上传完成');
    expect(() => turnInput('Wait', [{ ...attachment, status: 'failed' }])).toThrow('上传完成');
  });

  it('retains PDF context across queue edits, side-chat draft round trips and interrupted edits', () => {
    const input = turnInput('Original', [attachment, { url: 'image' }]);
    const edited = replaceQueuedText(input, 'Changed');
    expect(documentReferences(edited)).toEqual([document]);
    const draft = queuedDraft(edited);
    expect(draft.text).toBe('Changed');
    expect(draft.attachments).toMatchObject([{ url: 'image' }, { kind: 'document', ...document }]);
    expect(turnInput(draft.text, draft.attachments, draft.skills)).toEqual(edited);
    expect(documentReferences(editedMessageInput({
      type: 'userMessage', id: 'input', content: input
    }, 'Interrupted edit'))).toEqual([document]);
  });

  it('preserves native non-PDF, mixed-file and application context through side-chat drafts', () => {
    for (const original of [
      '# Files mentioned by the user:\n\n## notes.txt: /private/notes.txt\n\n## My request:\nOriginal',
      withDocumentReferences('Original', [document]).replace('## My request:', '## notes.txt: /private/notes.txt\n\n## My request:'),
      '# Applications mentioned by the user:\n<appshot>context</appshot>\n\n## My request:\nOriginal'
    ]) {
      const input = [{ type: 'text', text: original, text_elements: [] }];
      const draft = queuedDraft(input);
      expect(turnInput(draft.text, draft.attachments, draft.skills)).toEqual(input);
      expect(draft.attachments).toEqual([]);
      expect(replaceQueuedText(input, 'Changed')[0]).toMatchObject({
        text: original.replace(/Original$/, 'Changed')
      });
    }
  });
  it('renders a PDF preview link above the request without exposing the hidden file envelope', () => {
    const html = renderToStaticMarkup(createElement(MessageItem, {
      item: { type: 'userMessage', id: 'input', content: turnInput('Inspect this.', [attachment]) }
    }));
    expect(html).toContain('Report.pdf');
    expect(html).toContain('/api/file-preview/content//private/document-attachments/upload/Report.pdf');
    expect(html).not.toContain('Files mentioned by the user');
    expect(html.indexOf('user-document-attachment')).toBeLessThan(html.indexOf('Inspect this.'));
    expect(documentReferences([{ type: 'text', text: '## Report.pdf: /private/report.pdf\n## My request:\nText' }])).toEqual([]);
  });

  it('keeps an upload result on its original draft and excludes it from persistent text storage', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const drafts = createComposerDrafts(storage), original = drafts.open('first'), other = drafts.open('other');
    original.update(current => ({ ...current, attachments: [attachment] }));
    expect(other.get().attachments).toEqual([]);
    expect(drafts.open('first').get().attachments).toEqual([attachment]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('sends raw PDF bytes with an encoded name and retains uploaded references before model submission', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) =>
      new Response(JSON.stringify({ id: 'upload', ...document, size: 12 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF-1.7'], 'Report.pdf', { type: 'application/pdf' });
    const result = await uploadDocument(file, 'upload');
    expect(result).toMatchObject({ ...document, id: 'upload', kind: 'document', uploadId: 'upload', size: 12,
      url: '/api/file-preview/content//private/document-attachments/upload/Report.pdf' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', body: file, headers: { 'Content-Type': 'application/pdf', 'X-Attachment-Name': 'Report.pdf' },
      credentials: 'same-origin'
    });
    await retainDocuments([result, { id: 'image', name: 'image', url: 'image' }] satisfies ComposerAttachment[]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/attachments/upload/retain');
  });
});
