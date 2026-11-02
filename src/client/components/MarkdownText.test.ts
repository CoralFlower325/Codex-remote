import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from './MarkdownText';
import { PreviewLinks } from './PreviewLinks';

describe('static Markdown document preview', () => {
  it('renders the complete document with compiled formatting and workspace links', () => {
    const source = '# Acceptance\n\n'
      + 'A **strong** value and [status](./status.json).\n\n'
      + '| Item | Result |\n| --- | --- |\n| Synthetic | Passed |\n\n'
      + '```ts\nconst ready = true;\n```\n';
    const html = renderToStaticMarkup(createElement(PreviewLinks, { cwd: '/workspace',
      children: createElement(MarkdownText, { text: source, preserveDocument: true }) }));

    expect(html).toContain('<h1>Acceptance</h1>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code class="language-ts">const ready = true;\n</code></pre>');
    expect(html).toContain('href="/api/file-preview/content//workspace/status.json"');
  });
});
