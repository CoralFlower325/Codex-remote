import { memo, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export function mathHtml(expression: string, display: boolean): string | null {
  if (expression.length > 20_000) return null;
  try {
    return katex.renderToString(expression, {
      displayMode: display, output: 'htmlAndMathml', trust: false,
      throwOnError: true, strict: 'ignore', maxSize: 20, maxExpand: 1000
    });
  } catch {
    return null;
  }
}

export default memo(function MathFormula({ expression, display }: { expression: string; display: boolean }) {
  const html = useMemo(() => mathHtml(expression, display), [expression, display]);
  return html === null
    ? <span className="math-literal">{display ? `\\[${expression}\\]` : `\\(${expression}\\)`}</span>
    : <span className="math-rendered" dangerouslySetInnerHTML={{ __html: html }} />;
});
