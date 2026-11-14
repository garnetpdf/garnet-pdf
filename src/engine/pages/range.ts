/**
 * Page range parsing shared by the engine and the page dialogs. Pure TypeScript, no MuPDF.
 * Input page numbers are one-based ("1-5, 8, 11-"); results are zero-based indices.
 */
export class PageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRangeError';
  }
}

export interface RangeOptions {
  /** Keep the written order and repeats ("5-1, 3"). Default: sorted, unique. */
  keepOrder?: boolean;
}

/**
 * Accepts `all`, `odd`, `even`, `last`, single pages (`8`), closed ranges (`1-5`, `5-1` with keepOrder),
 * open ranges (`11-`, `-4`) and mixtures separated by commas or spaces.
 */
export function parsePageRange(input: string, pageCount: number, options: RangeOptions = {}): number[] {
  const text = input.trim().toLowerCase();
  if (pageCount <= 0) return [];
  if (!text || text === 'all') return Array.from({ length: pageCount }, (_, i) => i);
  const out: number[] = [];
  const parts = text
    .replace(/\s*-\s*/g, '-')
    .split(/[\s,;]+/)
    .filter(Boolean);
  const page = (token: string, fallback: number) => {
    if (!token) return fallback;
    if (token === 'last' || token === 'end') return pageCount;
    if (!/^\d+$/.test(token)) throw new PageRangeError(`"${token}" is not a page number.`);
    const value = Number(token);
    if (value < 1 || value > pageCount) throw new PageRangeError(`Page ${value} is outside this document (1-${pageCount}).`);
    return value;
  };
  for (const part of parts) {
    if (part === 'all') {
      for (let i = 0; i < pageCount; i++) out.push(i);
    } else if (part === 'odd' || part === 'even') {
      for (let i = part === 'odd' ? 0 : 1; i < pageCount; i += 2) out.push(i);
    } else if (part.includes('-')) {
      const [a, b, extra] = part.split('-');
      if (extra !== undefined) throw new PageRangeError(`"${part}" is not a valid range.`);
      const from = page(a, 1);
      const to = page(b, pageCount);
      if (from <= to) for (let i = from; i <= to; i++) out.push(i - 1);
      else if (options.keepOrder) for (let i = from; i >= to; i--) out.push(i - 1);
      else throw new PageRangeError(`"${part}" runs backwards. Write the lower page first.`);
    } else out.push(page(part, 1) - 1);
  }
  if (options.keepOrder) return out;
  return [...new Set(out)].sort((x, y) => x - y);
}

/** Compact zero-based indices into a one-based range string, e.g. `1-5, 8, 11-12`. */
export function formatPageRange(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j === i ? String(sorted[i] + 1) : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** True when the text parses; returns the message otherwise (for inline dialog validation). */
export function rangeError(input: string, pageCount: number, options?: RangeOptions): string | null {
  try {
    const result = parsePageRange(input, pageCount, options);
    return result.length ? null : 'Choose at least one page.';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
