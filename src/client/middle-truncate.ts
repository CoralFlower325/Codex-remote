export function middleTruncate(value: string, width: number, measure: (text: string) => number): string {
  if (width <= 0) return '';
  if (measure(value) <= width) return value;
  const ellipsis = '\u2026';
  if (measure(ellipsis) > width) return '';
  const characters = Array.from(value);
  const candidate = (count: number) => {
    const prefix = Math.ceil(count * 0.4);
    return characters.slice(0, prefix).join('') + ellipsis + (count > prefix ? characters.slice(-(count - prefix)).join('') : '');
  };
  let low = 0, high = characters.length - 1;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (measure(candidate(count)) <= width) low = count;
    else high = count - 1;
  }
  return candidate(low);
}
