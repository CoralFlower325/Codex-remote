export function appendBoundedLog(file: string, data: string | Uint8Array,
  options?: { maxBytes?: number; backups?: number }): void;
export function boundedLogWriter(file: string, options?: { maxBytes?: number; backups?: number }):
  (data: string | Uint8Array) => boolean;
