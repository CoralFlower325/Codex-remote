// Display-only projection of Desktop's heartbeat text protocol. Prompts require
// the native timestamp and instructions; replies may include visible prose
// outside a plain or fenced envelope. Never rewrite the stored message.

export interface HeartbeatPrompt {
  automationId: string | null;
  instructions: string;
}

export interface HeartbeatResponse {
  automationId: string | null;
  decision: 'NOTIFY' | 'DONT_NOTIFY';
  message: string;
  visibleText: string;
}

const responsePattern = /<heartbeat>[\s\S]*?<\/heartbeat>/gi;
const fencedResponsePattern = /```(?:xml)?\s*<heartbeat>[\s\S]*?<\/heartbeat>\s*```/gi;

function element(text: string, name: string): string | null {
  return new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i').exec(text)?.[1]?.trim() ?? null;
}

export function parseHeartbeatPrompt(text: string): HeartbeatPrompt | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<heartbeat>') || !trimmed.endsWith('</heartbeat>')) return null;
  const instructions = element(trimmed, 'instructions');
  if (element(trimmed, 'current_time_iso') === null || instructions === null) return null;
  return { automationId: element(trimmed, 'automation_id'), instructions };
}

export function parseHeartbeatResponse(text: string): HeartbeatResponse | null {
  const envelope = Array.from(text.matchAll(responsePattern)).at(-1)?.[0];
  if (!envelope) return null;
  const decision = /<decision>\s*(NOTIFY|DONT_NOTIFY)\s*<\/decision>/i.exec(envelope)?.[1]?.toUpperCase();
  if (decision !== 'NOTIFY' && decision !== 'DONT_NOTIFY') return null;
  const message = element(envelope, 'message') ?? '';
  return {
    automationId: element(envelope, 'automation_id'),
    decision,
    message: /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(message)?.[1]?.trim() ?? message,
    visibleText: text.trim().replace(fencedResponsePattern, '').replace(responsePattern, '').trim()
  };
}

export function heartbeatResponseText(text: string, streamingHeartbeat = false): string {
  const heartbeat = parseHeartbeatResponse(text);
  let displayText = heartbeat ? heartbeat.visibleText || heartbeat.message : text;
  if (streamingHeartbeat) {
    // Only callers with a native heartbeat prompt may hide incomplete tags.
    const start = displayText.toLowerCase().indexOf('<heartbeat>');
    const lastTag = displayText.lastIndexOf('<');
    const partial = lastTag >= 0 && '<heartbeat>'.startsWith(displayText.slice(lastTag).toLowerCase()) ? lastTag : -1;
    const cut = start >= 0 ? start : partial;
    if (cut >= 0) displayText = displayText.slice(0, cut).replace(/```(?:xml)?\s*$/i, '').trim();
  }
  return displayText;
}
