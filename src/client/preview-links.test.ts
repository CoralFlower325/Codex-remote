import { describe, expect, it } from 'vitest';
import { previewTarget } from './preview-links';
import { previewContentUrl } from '../shared/file-preview';

describe('native-style preview links', () => {
  it('keeps Windows drive paths and native line suffixes', () => {
    expect(previewTarget('F:/Projects/My%20App/src/main.ts:42:3', '/unused'))
      .toEqual({ kind: 'file', path: 'F:/Projects/My App/src/main.ts', line: 42 });
    expect(previewTarget('file:///C:/Projects/code.ts#L12-L16', ''))
      .toEqual({ kind: 'file', path: 'C:/Projects/code.ts', line: 12 });
    for (const value of ['/F:/Projects/docs/pr-7-review.md:12', '/F%3A/Projects/docs/pr-7-review.md:12',
      '\\F:\\Projects\\docs\\pr-7-review.md:12']) {
      expect(previewTarget(value, 'F:/Projects')).toEqual({ kind: 'file', path: 'F:/Projects/docs/pr-7-review.md', line: 12 });
    }
    expect(previewContentUrl('/F:/Projects/docs/pr-7-review.md'))
      .toBe('/api/file-preview/content/F%3A/Projects/docs/pr-7-review.md');
  });
  it('preserves UNC roots, POSIX paths and encoded filename suffixes', () => {
    expect(previewTarget('file://server/share/docs/report.md#L3', ''))
      .toEqual({ kind: 'file', path: '//server/share/docs/report.md', line: 3 });
    expect(previewTarget('\\\\server\\share\\..\\report.md', ''))
      .toEqual({ kind: 'file', path: '//server/share/report.md' });
    expect(previewTarget('/tmp/report%23L12', ''))
      .toEqual({ kind: 'file', path: '/tmp/report#L12' });
    expect(previewTarget('result.md', '/F:/Projects'))
      .toEqual({ kind: 'file', path: 'F:/Projects/result.md' });
  });
  it('resolves document links against the current Windows or macOS workspace', () => {
    expect(previewTarget('../notes/result.md', 'F:\\Projects\\atlas\\src'))
      .toEqual({ kind: 'file', path: 'F:/Projects/atlas/notes/result.md' });
    expect(previewTarget('./status.json', '/Users/operator/atlas'))
      .toEqual({ kind: 'file', path: '/Users/operator/atlas/status.json' });
    expect(previewContentUrl('/Users/operator/My Project/page.html'))
      .toBe('/api/file-preview/content//Users/operator/My%20Project/page.html');
  });
  it('previews websites without converting unsafe schemes or page fragments into files', () => {
    expect(previewTarget('https://example.com/report', '')).toEqual({ kind: 'url', url: 'https://example.com/report' });
    for (const value of ['javascript:alert(1)', 'data:text/html,test', '#heading', '/api/local-image?path=x']) {
      expect(previewTarget(value, '/project')).toBeNull();
    }
  });
});
