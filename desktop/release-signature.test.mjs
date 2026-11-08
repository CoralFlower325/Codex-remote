import { describe, expect, it } from 'vitest';
import { verifyRelease } from './release-signature.mjs';
import { signedFixture } from '../scripts/test-release-signing.mjs';
describe('publisher authenticity', () => {
  it('authenticates the entire release identity regardless of JSON key order', () => {
    const { signed, keys } = signedFixture({ version: '0.2.23', commit: 'a'.repeat(40), archive: { sha256: 'b'.repeat(64) } });
    expect(verifyRelease({ ...signed }, keys)).toEqual(signed);
    expect(() => verifyRelease({ ...signed, version: '9.9.9' }, keys)).toThrow('签名');
    expect(() => verifyRelease({ ...signed, commit: 'c'.repeat(40) }, keys)).toThrow('签名');
    expect(() => verifyRelease(signed, {})).toThrow('签名');
    expect(() => verifyRelease({ version: signed.version }, keys)).toThrow('签名');
    const reordered = { archive: { sha256: 'b'.repeat(64) }, signature: signed.signature,
      commit: 'a'.repeat(40), version: '0.2.23' };
    expect(verifyRelease(reordered, keys)).toEqual(signed);
    expect(() => verifyRelease({ ...signed, archive: { sha256: '0'.repeat(64) } }, keys)).toThrow('签名');
    expect(() => verifyRelease({ ...signed, sources: { 'src/injected.ts': 'f'.repeat(40) } }, keys)).toThrow('签名');
    const foreign = signedFixture({ version: signed.version });
    expect(() => verifyRelease(foreign.signed, keys)).toThrow('签名');
    expect(() => verifyRelease({ ...signed, signature: { ...signed.signature, algorithm: 'sha256' } }, keys)).toThrow('签名');
  });
});
