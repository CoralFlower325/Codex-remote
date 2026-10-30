import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectPullRequests, projectSummaryItems, readThreadSummaryPage } from './thread-summary.js';

const entry = (item: Record<string, unknown>, completedAtMs: number | null = 200) =>
  ({ turnId: 'turn', item, completedAtMs });
describe('native summary projection', () => {
  it('extracts final artifacts, structured file mentions and sources without raw tool or reasoning bodies', () => {
    const result = projectSummaryItems([
      entry({ type: 'agentMessage', phase: 'final_answer',
        text: '[Report](report.docx) [中文](%E6%8A%A5%E5%91%8A.pdf) [中文原名](报告.pdf)\n`[code](skip.pdf)`\n\n```\n[x](hidden.pdf)\n```' }),
      entry({ type: 'agentMessage', phase: 'commentary', text: '[x](commentary.pdf)' }),
      entry({ type: 'agentMessage', phase: 'final_answer', text: '[x](unfinished.pdf)' }, null),
      entry({ type: 'reasoning', text: '[secret](private.pdf)' }),
      entry({ type: 'userMessage', content: [{ type: 'localImage', path: '/input.png' },
        { type: 'text', text: '## note.docx: /input/note.docx\n\n[Reference](https://example.com/ref)' }] }),
      entry({ type: 'commandExecution', aggregatedOutput: 'SECRET', command: 'secret' }),
      entry({ type: 'webSearch', action: { query: 'example query' } })
    ]);
    expect(result.outputs.map(row => row.label)).toEqual(['Report', '中文', '中文原名']);
    expect(result.sources.map(row => row.target).filter(Boolean)).toEqual(['/input.png', '/input/note.docx', 'https://example.com/ref']);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|commentary\.pdf|unfinished\.pdf|private\.pdf|hidden\.pdf|skip\.pdf/);
  });

  it('rejects unsafe or malformed link schemes and credential URLs', () => {
    const result = projectSummaryItems([entry({ type: 'userMessage', content: [{
      type: 'text', text: '[bad](javascript:alert) [bad](https://%broken) [bad](https://user:secret@example.com/) [bad](data:x) [ok](../notes/报告.pdf)'
    }] })]);
    expect(result.sources.map(row => row.target)).toEqual(['../notes/报告.pdf']);
  });

  it('deduplicates connectors and reads native resource activity metadata only on successful calls', () => {
    const item = { type: 'mcpToolCall', status: 'completed', server: 'example', tool: 'create_file',
      appContext: { connectorId: 'example', appName: 'Example Drive' },
      result: { content: [{ type: 'text', text: 'SECRET RAW RESULT' }], _meta: {
        'openai/resourceActivities': { version: 1, resources: [
          { id: '1', url: 'https://example.com/document/1', title: 'Created document', activities: ['created'] },
          { id: '2', url: 'https://example.com/document/2', title: 'Read document', activities: ['read'] }
        ] }
      } } };
    const result = projectSummaryItems([entry(item), entry(item), entry({ ...item, status: 'failed', server: 'failed' })]);
    expect(result.outputs).toHaveLength(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].label).toBe('Example Drive');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('projects only valid native PR attachments', () => {
    expect(projectPullRequests([
      { id: 'a', attachmentType: 'pull_request', payload: { url: 'https://github.com/demo/repo/pull/12' } },
      { id: 'b', attachmentType: 'pull_request', payload: { url: 'https://gitlab.com/group/repo/-/merge_requests/4' } },
      { id: 'c', attachmentType: 'other', payload: { url: 'https://github.com/demo/repo/pull/1' } },
      { id: 'd', attachmentType: 'pull_request', payload: { url: 'javascript:alert(1)' } },
      { id: 'e', attachmentType: 'pull_request', payload: { url: 'https://user:secret@example.com/demo/repo/pull/1' } }
    ]).map(row => row.label)).toEqual(['demo/repo #12', 'group/repo #4']);
  });

  it('keeps independent cursors, bounds native reads, resolves cwd and excludes missing host outputs', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'remote-summary-'));
    try {
      await writeFile(path.join(cwd, 'report.pdf'), 'synthetic');
      const request = vi.fn(async (method: string) => method === 'thread/read' ? { thread: { cwd } }
        : method === 'thread/items/list' ? { data: [entry({ id: 'final', type: 'agentMessage', phase: 'final_answer',
          text: '[Report](report.pdf) [Missing](missing.docx)' })], nextCursor: 'items-2' }
        : { data: [], nextCursor: 'attachments-2' });
      const result = await readThreadSummaryPage(request, 'chat', null, null);
      expect(result.outputs.map(row => row.target)).toEqual([path.join(cwd, 'report.pdf')]);
      expect(result).toMatchObject({ nextCursor: 'items-2', attachmentsCursor: 'attachments-2', itemKeys: ['turn:final'] });
      expect(request).toHaveBeenCalledWith('thread/items/list', { threadId: 'chat', limit: 100, sortDirection: 'desc' });
      request.mockClear();
      await readThreadSummaryPage(request, 'chat', 'items-2', null);
      expect(request).not.toHaveBeenCalledWith('thread/attachment/list', expect.anything());
      request.mockClear();
      const attachmentPage = await readThreadSummaryPage(request, 'chat', null, 'attachments-2', true);
      expect(request).toHaveBeenCalledExactlyOnceWith('thread/attachment/list', { threadId: 'chat', limit: 100, cursor: 'attachments-2' });
      expect(attachmentPage.outputs).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
