import { describe, expect, it } from 'vitest';
import { middleTruncate } from './middle-truncate';

describe('middle path truncation', () => {
  const measure = (value: string) => Array.from(value).length;
  it('preserves the beginning and filename tail within the available width', () => {
    const value = 'F:/projects/a-very-long-directory/docs/pr-7-review.md';
    const result = middleTruncate(value, 26, measure);
    expect(result).toContain('\u2026');
    expect(result.startsWith('F:/')).toBe(true);
    expect(result.endsWith('pr-7-review.md')).toBe(true);
    expect(measure(result)).toBeLessThanOrEqual(26);
    expect(middleTruncate(value, 100, measure)).toBe(value);
  });
  it('handles tiny widths and complete Unicode characters', () => {
    expect(middleTruncate('abcdef', 0, measure)).toBe('');
    expect(middleTruncate('abcdef', 1, measure)).toBe('\u2026');
    const result = middleTruncate('\u{1f4c1}123456789.txt', 8, measure);
    expect(result).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u);
    expect(measure(result)).toBeLessThanOrEqual(8);
  });
});
