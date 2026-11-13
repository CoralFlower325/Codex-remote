export class UntrustedOriginError extends Error {
  readonly status = 403;

  constructor() {
    super('当前访问地址未加入信任来源，请检查 PUBLIC_ORIGINS 或 ALLOWED_ORIGINS。');
    this.name = 'UntrustedOriginError';
  }
}

export function normalizeOrigin(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username || parsed.password || parsed.pathname !== '/' ||
    parsed.search || parsed.hash) {
    return null;
  }
  return parsed.origin;
}

export function parseOriginList(value: string | null | undefined, name: string): string[] {
  const origins: string[] = [];
  for (const entry of (value ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(entry);
    if (!origin) throw new Error(`${name} 包含无效来源：${entry}`);
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export function resolvePublicOrigins(
  publicOriginValue: string | null | undefined,
  publicOriginsValue: string | null | undefined
): { publicOrigin: string | null; publicOrigins: string[] } {
  const configured = normalizeOrigin(publicOriginValue);
  if (publicOriginValue?.trim() && !configured) {
    throw new Error(`PUBLIC_ORIGIN 包含无效来源：${publicOriginValue}`);
  }
  const publicOrigins = parseOriginList(publicOriginsValue, 'PUBLIC_ORIGINS');
  const ordered = [...new Set([...(configured ? [configured] : []), ...publicOrigins])];
  return { publicOrigin: configured ?? ordered[0] ?? null, publicOrigins: ordered };
}

export function assertTrustedOrigin(origin: string | undefined, allowedOrigins: readonly string[]): void {
  if (origin && !allowedOrigins.includes(origin)) throw new UntrustedOriginError();
}
