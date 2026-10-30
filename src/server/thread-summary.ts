import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent } from 'mdast';
import type { ClientRpcMethod } from '../shared/protocol.js';
import type { SummaryResource, ThreadSummaryPage } from '../shared/thread-summary.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type RecordValue = Record<string, any>;
const markdown = unified().use(remarkParse);
const outputExtension = /\.(?:pdf|docx?|odt|pptx?|odp|xlsx?|ods|csv|tsv|md|txt|rtf|html?|png|jpe?g|webp|gif|svg|avif|mp4|webm|mp3|wav|zip)(?:[?#].*)?$/i;
const fileName = (target: string) => target.replace(/\\/g, '/').split('/').at(-1) || target;

function safeTarget(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  if (/^(?:file:\/\/|[a-z]:[\\/]|\/)/i.test(value) && !value.startsWith('//')) return value;
  if (!/^[a-z][\w+.-]*:/i.test(value) && !value.startsWith('//') &&
    /^[^<>|?*\0\r\n]+\.[\w.-]+(?:#.*)?$/u.test(value)) return value;
  return null;
}

function resource(target: string, label?: string): SummaryResource {
  const web = /^https?:\/\//i.test(target);
  const cleaned = web ? target : target.replace(/\\/g, '/').replace(/(?::\d+(?::\d+)?|#L\d+.*)$/, '');
  return { id: `${web ? 'url' : 'file'}:${cleaned}`, kind: web ? 'website' : 'file',
    target: cleaned, label: label?.trim().slice(0, 500) || (web ? new URL(target).hostname : fileName(cleaned)) };
}

function markdownResources(text: string): SummaryResource[] {
  const root = markdown.parse(text) as Root;
  const definitions = new Map(root.children.flatMap(node => node.type === 'definition' ? [[node.identifier, node.url] as const] : []));
  const rows: SummaryResource[] = [];
  const label = (node: RootContent | any): string => node.value ?? node.alt ?? node.children?.map(label).join('') ?? '';
  const visit = (node: RootContent | Root | any) => {
    if (['code', 'inlineCode', 'html'].includes(node.type)) return;
    const href = node.type === 'link' || node.type === 'image' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : null;
    const target = safeTarget(href);
    if (target) rows.push(resource(target, label(node)));
    if (node.type === 'heading') {
      // Desktop injects mentioned host files into structured Markdown headings.
      const match = label(node).match(/^.+?:\s+((?:[a-z]:[\\/]|\/)[^\r\n]+)$/i);
      const path = match ? safeTarget(match[1]) : null;
      if (path) rows.push(resource(path));
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return rows;
}

export function projectSummaryItems(entries: Array<{ turnId: string; completedAtMs?: number | null; item: RecordValue }>) {
  const outputs = new Map<string, SummaryResource>();
  const sources = new Map<string, SummaryResource>();
  const add = (destination: Map<string, SummaryResource>, row: SummaryResource) => {
    if (!destination.has(row.id)) destination.set(row.id, row);
  };
  for (const { item, completedAtMs } of entries) {
    if (item.type === 'agentMessage' && completedAtMs != null &&
      !['commentary', 'partial_answer'].includes(item.phase) && typeof item.text === 'string') {
      for (const row of markdownResources(item.text)) {
        if (outputExtension.test(row.target!) || /^https:\/\/(?:docs\.google\.com|[^/]*notion\.so|(?:www\.)?figma\.com)\//i.test(row.target!)) add(outputs, row);
      }
    }
    if (item.type === 'imageGeneration' && (completedAtMs != null || item.status === 'completed')) {
      const target = safeTarget(item.src ?? item.path);
      if (target) add(outputs, resource(target, '生成的图像'));
    }
    if (item.type === 'userMessage') for (const input of item.content ?? []) {
      const target = safeTarget(input.path ?? (input.type === 'image' ? input.url : null));
      if (target) add(sources, resource(target));
      if (input.type === 'text' && typeof input.text === 'string') {
        for (const row of markdownResources(input.text)) add(sources, row);
      }
    }
    if (item.type === 'webSearch') {
      add(sources, { id: 'web-search', kind: 'webSearch', label: '网页搜索',
        detail: item.action?.queries?.join('、') || item.action?.query || item.query || undefined });
      const target = safeTarget(item.action?.url);
      if (target && /^https?:/.test(target)) add(sources, resource(target));
    }
    if (item.type === 'mcpToolCall' && item.status === 'completed' && !item.error) {
      const context = item.appContext;
      const server = String(context?.connectorId ?? item.server ?? '');
      if (!server || /^(?:plugin-runtime|tool_search)$/.test(server)) continue;
      const names: Record<string, string> = { codex_app: 'ChatGPT App Tools', github: 'GitHub MCP Server' };
      const label = context?.appName || names[server.replace(/^mcp__/, '')] || server.replace(/^mcp__/, '').replace(/[_-]+/g, ' ');
      add(sources, { id: `connector:${server}`, kind: 'connector', label: String(label).slice(0, 500),
        detail: String(item.tool ?? '').slice(0, 500) });
      for (const external of externalResources(item)) {
        const target = safeTarget(external.url);
        if (!target || !/^https?:/.test(target)) continue;
        const row = resource(target, external.title);
        if (external.activities.some(activity => ['created', 'updated'].includes(activity))) add(outputs, row);
        if (external.activities.some(activity => ['read', 'provided'].includes(activity))) add(sources, row);
      }
    }
  }
  return { outputs: [...outputs.values()], sources: [...sources.values()] };
}

function externalResources(item: RecordValue): Array<{ url: unknown; title?: string; activities: string[] }> {
  // Only structured resource fields are projected; arbitrary tool text stays private.
  const result = item.result;
  const metadata = result?._meta?.['openai/resourceActivities'];
  const resources = metadata?.version === 1 ? metadata.resources : null;
  if (Array.isArray(resources)) return resources.slice(0, 100).flatMap(entry =>
    entry && Array.isArray(entry.activities) ? [{
      url: entry.url, title: typeof entry.title === 'string' ? entry.title : undefined,
      activities: entry.activities.filter((value: unknown): value is string => typeof value === 'string')
    }] : []);
  const tool = String(item.tool ?? '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const content = result?.structuredContent;
  if (content && /(?:create|copy|import|duplicate|update|edit)_/.test(tool) &&
    /(?:google|drive)/i.test(String(item.server))) {
    const urls = Array.isArray(content.urls) ? content.urls : [content.url];
    return urls.slice(0, 20).map((url: unknown) => ({ url, title: content.title, activities: ['created'] }));
  }
  return [];
}

export function projectPullRequests(attachments: RecordValue[]): SummaryResource[] {
  return attachments.flatMap(attachment => {
    if (attachment.attachmentType !== 'pull_request') return [];
    const url = attachment.payload?.url;
    if (typeof url !== 'string') return [];
    let parsed: URL;
    try { parsed = new URL(url); } catch { return []; }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    const match = parsed.pathname.match(/^\/(.+?)\/(?:pull|merge_requests|-\u002fmerge_requests)\/(\d+)\/?$/);
    if (!match) return [];
    return [{ id: String(attachment.id ?? attachment.identityKey ?? url), kind: 'pullRequest' as const,
      label: typeof attachment.payload.title === 'string' ? attachment.payload.title.slice(0, 500) : `${match[1]} #${match[2]}`,
      target: url }];
  });
}

export async function readThreadSummaryPage(
  request: (method: ClientRpcMethod, params: unknown) => Promise<unknown>,
  threadId: string, cursor: string | null, attachmentsCursor: string | null, attachmentsOnly = false
): Promise<ThreadSummaryPage> {
  const [items, attachments, thread] = await Promise.all([
    attachmentsOnly ? null : request('thread/items/list', { threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }),
    !cursor || attachmentsCursor || attachmentsOnly ? request('thread/attachment/list', {
      threadId, limit: 100, ...(attachmentsCursor ? { cursor: attachmentsCursor } : {})
    }) : null,
    attachmentsOnly ? null : request('thread/read', { threadId, includeTurns: false })
  ]) as [{ data: Array<{ turnId: string; completedAtMs?: number | null; item: RecordValue }>; nextCursor: string | null } | null,
    { data: RecordValue[]; nextCursor: string | null } | null, { thread: { cwd?: string } } | null];
  const projected = projectSummaryItems(items?.data ?? []);
  const outputs = (await Promise.all(projected.outputs.map(async row => {
    if (row.kind !== 'file' || !row.target) return row;
    try {
      const decoded = /^file:/i.test(row.target) ? fileURLToPath(row.target) : decodeURIComponent(row.target);
      const absolute = path.isAbsolute(decoded) ? decoded : thread?.thread.cwd ? path.resolve(thread.thread.cwd, decoded) : null;
      if (!absolute || !(await stat(absolute)).isFile()) return null;
      return { ...row, target: absolute, id: `file:${absolute.replace(/\\/g, '/')}` };
    } catch { return null; }
  }))).filter((row): row is SummaryResource => row !== null);
  return { outputs, sources: projected.sources, pullRequests: projectPullRequests(attachments?.data ?? []),
    nextCursor: items?.nextCursor ?? null, attachmentsCursor: attachments?.nextCursor ?? null,
    itemKeys: items?.data.map(entry => `${entry.turnId}:${entry.item.id}`).slice(0, 100) ?? [] };
}
