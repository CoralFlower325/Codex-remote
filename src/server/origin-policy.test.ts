import { describe, expect, it } from 'vitest';

import {
  assertTrustedOrigin,
  normalizeOrigin,
  parseOriginList,
  resolvePublicOrigins,
  UntrustedOriginError
} from './origin-policy.js';

describe('origin policy', () => {
  it('normalizes canonical HTTP(S) origins', () => {
    expect(normalizeOrigin(' HTTPS://Example.COM/ ')).toBe('https://example.com');
    expect(normalizeOrigin('http://localhost:4545')).toBe('http://localhost:4545');
    expect(normalizeOrigin('')).toBeNull();
  });

  it('rejects credentials, paths, queries, fragments and non-HTTP schemes', () => {
    for (const value of [
      'ftp://example.com',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com/?q=1',
      'https://example.com/#fragment'
    ]) {
      expect(normalizeOrigin(value)).toBeNull();
    }
  });

  it('deduplicates configured public origins and retains canonical order', () => {
    expect(resolvePublicOrigins(
      'https://primary.example.com/',
      'https://backup.example.com, https://primary.example.com/, https://backup.example.com'
    )).toEqual({
      publicOrigin: 'https://primary.example.com',
      publicOrigins: ['https://primary.example.com', 'https://backup.example.com']
    });
  });

  it('can derive the canonical origin from PUBLIC_ORIGINS', () => {
    expect(resolvePublicOrigins('', 'https://first.example.com,https://second.example.com'))
      .toEqual({
        publicOrigin: 'https://first.example.com',
        publicOrigins: ['https://first.example.com', 'https://second.example.com']
      });
  });

  it('fails closed for an invalid configured origin', () => {
    expect(() => parseOriginList('https://example.com/path', 'ALLOWED_ORIGINS'))
      .toThrow('ALLOWED_ORIGINS');
    expect(() => resolvePublicOrigins('https://example.com/?query=1', ''))
      .toThrow('PUBLIC_ORIGIN');
  });

  it('rejects an explicit untrusted Origin but preserves non-browser requests', () => {
    expect(() => assertTrustedOrigin('https://evil.example.com', ['https://trusted.example.com']))
      .toThrow(UntrustedOriginError);
    expect(() => assertTrustedOrigin(undefined, ['https://trusted.example.com'])).not.toThrow();
    expect(() => assertTrustedOrigin('https://trusted.example.com', ['https://trusted.example.com']))
      .not.toThrow();
  });
});
