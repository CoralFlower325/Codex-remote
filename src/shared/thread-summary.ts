export interface SummaryResource {
  id: string;
  kind: 'file' | 'website' | 'connector' | 'webSearch' | 'pullRequest';
  label: string;
  target?: string;
  detail?: string;
}

export interface ThreadSummaryPage {
  outputs: SummaryResource[];
  sources: SummaryResource[];
  pullRequests: SummaryResource[];
  nextCursor: string | null;
  attachmentsCursor: string | null;
  itemKeys?: string[];
}

export function mergeSummaryResources(current: SummaryResource[], incoming: SummaryResource[]) {
  const result = new Map(current.map(row => [row.id, row]));
  for (const row of incoming) if (!result.has(row.id)) result.set(row.id, row);
  return [...result.values()];
}
