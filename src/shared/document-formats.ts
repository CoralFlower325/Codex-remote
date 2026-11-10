const supportedDocumentExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv',
  '.doc', '.docx',
  '.go', '.h', '.hpp', '.htm', '.html',
  '.ini', '.ipynb',
  '.java', '.js', '.json', '.jsx',
  '.log',
  '.markdown', '.md', '.mdx',
  '.pdf',
  '.php', '.ppt', '.pptx', '.ps1', '.py',
  '.rb', '.rs', '.rtf',
  '.sh', '.sql',
  '.toml', '.ts', '.tsv', '.tsx', '.txt',
  '.xls', '.xlsx', '.xml',
  '.yaml', '.yml'
]);

export const documentAccept = [...supportedDocumentExtensions].join(',');

export function documentExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function isSupportedDocumentName(name: string): boolean {
  return supportedDocumentExtensions.has(documentExtension(name));
}
