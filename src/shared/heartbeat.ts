// Desktop automations ("heartbeats") persist their trigger and reply as XML
// envelopes inside ordinary message text. Desktop renders only the payload:
// the instructions for the trigger and the message for the reply. These
// parsers project the same native display from the stored text; the stored
// items themselves are never rewritten. A text is an envelope only when the
// whole trimmed message matches, so user prose that merely quotes the tags
// stays literal.

export interface HeartbeatPrompt {
  automationId: string | null;
  instructions: string;
}

export interface HeartbeatResponse {
  automationId: string | null;
  decision: string;
  message: string;
}

const promptPattern =
  /^\s*<heartbeat>\s*((?:<automation_id>[^<]*<\/automation_id>\s*)?(?:<current_time_iso>[^<]*<\/current_time_iso>\s*)?)<instructions>([\s\S]*?)<\/instructions>\s*<\/heartbeat>\s*$/;
const responsePattern =
  /^\s*<heartbeat>\s*(<automation_id>[^<]*<\/automation_id>\s*)?<decision>([^<]*)<\/decision>\s*<message>([\s\S]*?)<\/message>\s*<\/heartbeat>\s*$/;
const automationIdPattern = /<automation_id>([^<]*)<\/automation_id>/;

function automationId(head: string | undefined): string | null {
  const id = head ? automationIdPattern.exec(head)?.[1]?.trim() : undefined;
  return id || null;
}

export function parseHeartbeatPrompt(text: string): HeartbeatPrompt | null {
  const match = promptPattern.exec(text);
  const instructions = match?.[2]?.trim();
  if (!match || !instructions) return null;
  return { automationId: automationId(match[1]), instructions };
}

export function parseHeartbeatResponse(text: string): HeartbeatResponse | null {
  const match = responsePattern.exec(text);
  const message = match?.[3]?.trim();
  if (!match || !message) return null;
  return { automationId: automationId(match[1]), decision: match[2]!.trim(), message };
}

// The reply text Desktop would show: the heartbeat message for an envelope,
// the original text otherwise.
export function heartbeatResponseText(text: string): string {
  return parseHeartbeatResponse(text)?.message ?? text;
}
