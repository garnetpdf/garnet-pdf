/**
 * Page labels (/PageLabels number tree). Labels are positional ranges: a range starts at a page
 * index and numbers the pages after it until the next range. Policies used by page operations:
 *  - reorder, rotate: ranges unchanged (labels stay with positions, as in Acrobat);
 *  - delete: ranges shift with the surviving pages; a range whose first page was deleted starts at
 *    the next surviving page; ranges left without pages are dropped;
 *  - insert, duplicate, paste: inserted pages join the range of the page before them (insert at
 *    the front joins the first range);
 *  - extract, split, combine, replace: each copied page keeps its own label; ranges are rebuilt
 *    compactly from the per-page labels.
 */
import type { Doc, Obj } from './pdf';

export type LabelStyle = 'D' | 'R' | 'r' | 'A' | 'a' | '';
export interface LabelRange {
  start: number;
  style: LabelStyle;
  prefix: string;
  first: number;
}
export interface LabelSpec {
  style: LabelStyle;
  prefix: string;
  value: number;
}

const STYLES = new Set(['D', 'R', 'r', 'A', 'a']);

export function readLabelRanges(pdf: Doc): LabelRange[] | null {
  const tree = pdf.getTrailer().get('Root').get('PageLabels');
  if (!tree.isDictionary()) return null;
  const byStart = new Map<number, LabelRange>();
  const seen = new Set<number>();
  const visit = (node: Obj, depth: number) => {
    if (depth > 32) return;
    if (node.isIndirect()) {
      if (seen.has(node.asIndirect())) return;
      seen.add(node.asIndirect());
    }
    const nums = node.get('Nums');
    if (nums.isArray()) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const key = nums.get(i);
        if (!key.isNumber()) continue;
        const start = Math.trunc(key.asNumber());
        if (start < 0) continue;
        const dict = nums.get(i + 1);
        const s = dict.get('S');
        const style = (s.isName() && STYLES.has(s.asName()) ? s.asName() : '') as LabelStyle;
        const p = dict.get('P');
        const st = dict.get('St');
        byStart.set(start, { start, style, prefix: p.isString() ? p.asString() : '', first: st.isNumber() ? Math.max(1, Math.trunc(st.asNumber())) : 1 });
      }
    }
    const kids = node.get('Kids');
    if (kids.isArray()) for (let i = 0; i < kids.length; i++) visit(kids.get(i), depth + 1);
  };
  visit(tree, 0);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

function sameRanges(a: readonly LabelRange[] | null, b: readonly LabelRange[] | null): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((r, i) => r.start === b[i].start && r.style === b[i].style && r.prefix === b[i].prefix && r.first === b[i].first);
}

/** Writes the ranges (null or empty removes /PageLabels). Skips the write when nothing changes. */
export function writeLabelRanges(pdf: Doc, ranges: readonly LabelRange[] | null, pageCount: number): void {
  const root = pdf.getTrailer().get('Root');
  const clean = ranges ? normaliseRanges(ranges, pageCount) : null;
  if (!clean || !clean.length) {
    if (!root.get('PageLabels').isNull()) root.delete('PageLabels');
    return;
  }
  if (sameRanges(readLabelRanges(pdf), clean) && root.get('PageLabels', 'Kids').isNull()) return;
  const nums = pdf.newArray();
  for (const range of clean) {
    nums.push(range.start);
    const dict = pdf.newDictionary();
    if (range.style) dict.put('S', pdf.newName(range.style));
    if (range.prefix) dict.put('P', pdf.newString(range.prefix));
    if (range.first !== 1) dict.put('St', range.first);
    nums.push(dict);
  }
  const tree = pdf.newDictionary();
  tree.put('Nums', nums);
  root.put('PageLabels', tree);
}

export function normaliseRanges(ranges: readonly LabelRange[], pageCount: number): LabelRange[] {
  const byStart = new Map<number, LabelRange>();
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || range.start < 0 || range.start >= pageCount) continue;
    byStart.set(range.start, { start: range.start, style: STYLES.has(range.style) ? range.style : '', prefix: range.prefix ?? '', first: Math.max(1, Math.trunc(range.first) || 1) });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

export function rangeFor(ranges: readonly LabelRange[], index: number): LabelRange | undefined {
  let found: LabelRange | undefined;
  for (const range of ranges) {
    if (range.start <= index) found = range;
    else break;
  }
  return found;
}

export function roman(value: number): string {
  if (value <= 0 || value >= 4000) return String(value);
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [n, s] of table) while (value >= n) { out += s; value -= n; }
  return out;
}

export function alpha(value: number): string {
  if (value <= 0) return String(value);
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

export function formatSpec(spec: LabelSpec): string {
  const body = spec.style === 'D' ? String(spec.value)
    : spec.style === 'r' ? roman(spec.value)
    : spec.style === 'R' ? roman(spec.value).toUpperCase()
    : spec.style === 'a' ? alpha(spec.value)
    : spec.style === 'A' ? alpha(spec.value).toUpperCase()
    : '';
  return spec.prefix + body;
}

/** Per-page label specs; pages before the first range get plain decimal numbers. */
export function specsFor(ranges: readonly LabelRange[] | null, pageCount: number): LabelSpec[] {
  const specs: LabelSpec[] = [];
  for (let i = 0; i < pageCount; i++) {
    const range = ranges ? rangeFor(ranges, i) : undefined;
    specs.push(range ? { style: range.style, prefix: range.prefix, value: range.first + (i - range.start) } : { style: 'D', prefix: '', value: i + 1 });
  }
  return specs;
}

export function labelStrings(ranges: readonly LabelRange[] | null, pageCount: number): string[] {
  return specsFor(ranges, pageCount).map(formatSpec);
}

/** Rebuilds compact ranges from per-page specs. */
export function compactSpecs(specs: readonly LabelSpec[]): LabelRange[] {
  const ranges: LabelRange[] = [];
  let previous: LabelSpec | undefined;
  specs.forEach((spec, index) => {
    const continues = previous && previous.style === spec.style && previous.prefix === spec.prefix && (spec.style === '' || spec.value === previous.value + 1);
    if (!continues) ranges.push({ start: index, style: spec.style, prefix: spec.prefix, first: spec.style === '' ? 1 : spec.value });
    previous = spec;
  });
  return ranges;
}

/** True when compact ranges equal plain 1..n decimal numbering (no /PageLabels needed). */
export function isPlainNumbering(ranges: readonly LabelRange[]): boolean {
  return ranges.length === 1 && ranges[0].start === 0 && ranges[0].style === 'D' && ranges[0].prefix === '' && ranges[0].first === 1;
}

export function afterDelete(ranges: readonly LabelRange[], deleted: ReadonlySet<number>, oldCount: number): LabelRange[] {
  const survivorsBefore = new Int32Array(oldCount + 1);
  for (let i = 0; i < oldCount; i++) survivorsBefore[i + 1] = survivorsBefore[i] + (deleted.has(i) ? 0 : 1);
  const newCount = survivorsBefore[oldCount];
  const byStart = new Map<number, LabelRange>();
  for (const range of ranges) {
    const start = survivorsBefore[Math.min(range.start, oldCount)];
    if (start < newCount) byStart.set(start, { ...range, start });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

export function afterInsert(ranges: readonly LabelRange[], at: number, count: number): LabelRange[] {
  const from = Math.max(at, 1);
  return ranges.map((range) => (range.start >= from ? { ...range, start: range.start + count } : { ...range }));
}
