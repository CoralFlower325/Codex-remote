import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import { describe, expect, it } from 'vitest';
import { markdownBlocks, remarkAssistantSources } from './markdown-blocks';
import { normalizeMathDelimiters, remarkMathText } from './markdown-math';
import { mathHtml } from './components/MathFormula';

const render = (source: string) => renderToStaticMarkup(createElement(ReactMarkdown, {
  remarkPlugins: [remarkMath, remarkAssistantSources, remarkMathText],
  urlTransform: url => /^[a-z]:[\\/]/i.test(url) ? url : defaultUrlTransform(url),
  children: normalizeMathDelimiters(source)
}));

describe('conversation math', () => {
  it('supports inline and display delimiters without persisting a rewritten source', () => {
    const source = String.raw`From \(y_L=1+j2\), $x^2$.

\[
\boxed{Z_{\mathrm{in}}=\frac1{y_{\mathrm{in}}}\ \Omega}
\]`;
    const blocks = markdownBlocks(source);
    expect(blocks).toHaveLength(2);
    expect(render(blocks[0]!.text).match(/math-inline/g)).toHaveLength(2);
    expect(render(blocks[1]!.text)).toContain('math-display');
    expect(source).toContain(String.raw`\[`);
    expect(normalizeMathDelimiters(String.raw`\[a\]`)).toBe('$$\na\n$$');
    expect(render(String.raw`- Result: \[x^2\]`)).toContain('<li>Result: <code class="language-math math-display">');
    expect(render('Inline $$x^2$$ value')).toContain('math-display');
    for (const spaced of [String.raw`\( x+1 \)`, String.raw`\( x+1\)`, String.raw`\(x+1 \)`]) {
      expect(render(spaced)).toContain('math-inline');
    }
  });

  it('preserves code, code fences, HTML, links, images and escaped delimiters', () => {
    const source = 'Literal `\\(x\\)` and ' + String.raw`[\(x\)](https://example.com/\(path\)).

~~~tex
\[x\]
~~~

![\(x\)](/image.png)

<!-- \(hidden\) -->

\\(escaped\\)`;
    expect(normalizeMathDelimiters(source)).toBe(source);
    expect(render('[$x$](https://example.com)')).toBe('<p><a href="https://example.com">$x$</a></p>');
    expect(render('`$x$`')).toBe('<p><code>$x$</code></p>');
    expect(render(String.raw`\(\text{https://example.com}\)`)).toContain('math-inline');
    expect(render(String.raw`\( \href{https://example.com}{unsafe} \)`)).not.toContain('<a ');
    expect(normalizeMathDelimiters(String.raw`[literal \(x\)](https://example.com)`))
      .toBe(String.raw`[literal \(x\)](https://example.com)`);
  });

  it('does not typeset prices or an unfinished streamed formula', () => {
    expect(render('Costs $5 and $10, or $15.')).not.toContain('math-inline');
    expect(render('Costs $5, $10 and $15.')).not.toContain('math-inline');
    expect(render('$5$ and $x+1$').match(/math-inline/g)).toHaveLength(2);
    for (const source of [String.raw`\(\frac{1`, String.raw`\[x+1`, '$$', '$$\nx+1', '$$$\nx\n$$']) {
      const html = render(source);
      expect(html).not.toContain('class="language-math');
    }
    expect(render('$$\nx+1\n$$')).toContain('math-display');
  });

  it('keeps multiline formulas as one Markdown block and retains file citations', () => {
    const source = String.raw`Before.

\[
\begin{aligned}
a &= b \\

c &= d
\end{aligned}
\]

:codex-file-citation{path="C:/Project/results.md" purpose="output"}`;
    const blocks = markdownBlocks(source);
    expect(blocks).toHaveLength(3);
    expect(render(blocks[1]!.text)).toContain('math-display');
    expect(render(blocks[2]!.text)).toContain('href="C:/Project/results.md"');
    expect(render(String.raw`\(x\) :codex-file-citation{path="C:/Project/results.md"}`)).toContain('math-inline');
    const citation = ':codex-file-citation{path="C:/Project/results.md" purpose="output"}';
    expect(render(`${citation}\n\n$$\nx+1\n$$`)).toContain('math-display');
    expect(render(`${citation} $5 and $10.`)).not.toContain('math-inline');
    expect(render(`${citation}\n\n$$\nx+1`)).not.toContain('math-display');
    expect(render(`${citation} [$x$](https://example.com)`)).toContain('href="https://example.com">$x$</a>');
    const list = render(`- ${citation}\n\n  $$\n  x+1\n  $$`);
    expect(list).toContain('math-display">x+1');
    expect(render(`> ${citation}\n>\n> $$\n> x+1\n> $$`)).toContain('math-display">x+1');
  });

  it('renders real accessible equations and retains failed expressions as text', () => {
    const html = mathHtml(String.raw`\boxed{Z_{\mathrm{in}}=\frac1{y_{\mathrm{in}}}\ \Omega}`, true)!;
    expect(html).toContain('katex-display');
    expect(html).toContain('<math');
    expect(html).toContain('encoding="application/x-tex"');
    expect(html).toContain('frac');
    expect(mathHtml(String.raw`\unknowncommand{x}`, false)).toBeNull();
    expect(mathHtml('x'.repeat(20_001), false)).toBeNull();
  });

  it('blocks trusted commands and bounds macro expansion', () => {
    for (const input of [String.raw`\href{https://example.com}{click}`, String.raw`\includegraphics{https://example.com/x.png}`,
      String.raw`\htmlClass{unsafe}{x}`, String.raw`\def\a{\a}\a`]) {
      const html = mathHtml(input, false) ?? '';
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('class="unsafe"');
    }
    const html = mathHtml(String.raw`\rule{500em}{500em}`, false)!;
    expect(html).toContain('height:20em');
    expect(html).not.toContain('height:500em');
  });
});
