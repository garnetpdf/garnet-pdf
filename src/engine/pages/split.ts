/** Split planning: page groups and safe, unique file names. Pure apart from reading the PDF. */
import { NamedDests, destPageNum, itemDest, num, pageIndexByNum, pageRefs, readOutline, str, type Doc, type Obj } from './pdf';

export type SplitMode = 'every' | 'size' | 'bookmarks' | 'before';

export interface SplitOptions {
  mode: SplitMode;
  /** Pages per file (mode "every"). */
  every?: number;
  /** Largest file size in bytes (mode "size", estimated). */
  maxBytes?: number;
  /** One-based page numbers that start a new file (mode "before"). */
  before?: number[];
  /** File name pattern: {name} {n} {bookmark} {first} {last}. */
  pattern?: string;
  /** Source file name, used for {name}. */
  baseName?: string;
}

export interface SplitPart {
  name: string;
  /** Zero-based page indices. */
  pages: number[];
  bookmark?: string;
  estimatedBytes?: number;
  /** A single page that alone exceeds the size limit. */
  oversize?: boolean;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeFileName(input: string, fallback: string): string {
  let name = [...input].filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch)).join('');
  name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!name) name = fallback;
  if (RESERVED.test(name.split('.')[0])) name = `_${name}`;
  if (name.length > 150) name = name.slice(0, 150).trim();
  return name;
}

/** Adds " (2)", " (3)" to repeated names (case-insensitive, as on Windows). */
export function uniqueNames(names: readonly string[], taken: Iterable<string> = []): string[] {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  return names.map((name) => {
    const stem = name.replace(/\.pdf$/i, '');
    let candidate = `${stem}.pdf`;
    for (let k = 2; used.has(candidate.toLowerCase()); k++) candidate = `${stem} (${k}).pdf`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function streamBytes(obj: Obj): number {
  const length = obj.get('Length');
  return length.isNumber() ? length.asNumber() : 0;
}

/** Objects reachable from a page (resources, contents, annotations) with their stored sizes. */
function pageFootprint(page: Obj): Map<number, number> {
  const out = new Map<number, number>();
  const stack: Obj[] = [page.get('Contents'), page.getInheritable('Resources'), page.get('Annots')];
  let guard = 0;
  while (stack.length && guard++ < 100000) {
    const o = stack.pop()!;
    if (o.isIndirect()) {
      const id = o.asIndirect();
      if (out.has(id)) continue;
      out.set(id, 120 + (o.isStream() ? streamBytes(o) : 0));
    }
    if (o.isArray()) for (let i = 0; i < o.length; i++) stack.push(o.get(i));
    else if (o.isDictionary()) o.forEach((v, k) => { if (k !== 'Parent' && k !== 'P' && k !== 'Popup' && k !== 'IRT' && k !== 'Dest' && k !== 'A') stack.push(v); });
  }
  return out;
}

export function splitGroups(pdf: Doc, options: SplitOptions): SplitPart[] {
  const count = pdf.countPages();
  const parts: SplitPart[] = [];
  if (options.mode === 'every') {
    const every = Math.trunc(options.every ?? 0);
    if (!(every >= 1)) throw new Error('Choose how many pages go in each file.');
    for (let start = 0; start < count; start += every) parts.push({ name: '', pages: range(start, Math.min(count, start + every)) });
  } else if (options.mode === 'before') {
    const cuts = [...new Set((options.before ?? []).map((n) => Math.trunc(n) - 1))].filter((i) => i > 0 && i < count).sort((a, b) => a - b);
    if (!cuts.length) throw new Error('Choose at least one page to split before (not the first page).');
    const bounds = [0, ...cuts, count];
    for (let i = 0; i + 1 < bounds.length; i++) parts.push({ name: '', pages: range(bounds[i], bounds[i + 1]) });
  } else if (options.mode === 'bookmarks') {
    const refs = pageRefs(pdf);
    const indexByNum = pageIndexByNum(refs);
    const named = new NamedDests(pdf);
    const starts = new Map<number, string>();
    for (const node of readOutline(pdf).items) {
      const dest = itemDest(node.ref);
      const target = dest ? destPageNum(dest, named, refs) : null;
      const index = target === null ? undefined : indexByNum.get(target);
      if (index !== undefined && !starts.has(index)) starts.set(index, str(node.ref.get('Title')) || `Bookmark ${starts.size + 1}`);
    }
    if (!starts.size) throw new Error('This document has no top-level bookmarks to split by.');
    const sorted = [...starts.keys()].sort((a, b) => a - b);
    if (sorted[0] > 0) parts.push({ name: '', pages: range(0, sorted[0]), bookmark: '' });
    sorted.forEach((start, i) => parts.push({ name: '', pages: range(start, sorted[i + 1] ?? count), bookmark: starts.get(start) }));
  } else if (options.mode === 'size') {
    const maxBytes = options.maxBytes ?? 0;
    if (!(maxBytes >= 10_000)) throw new Error('Choose a file size of at least 10 KB.');
    let current: SplitPart | null = null;
    let union = new Map<number, number>();
    let total = 0;
    for (let i = 0; i < count; i++) {
      const footprint = pageFootprint(pdf.findPage(i));
      let extra = 0;
      for (const [id, size] of footprint) if (!union.has(id)) extra += size;
      if (current && total + extra > maxBytes) {
        current.estimatedBytes = total;
        current = null;
      }
      if (!current) {
        current = { name: '', pages: [] };
        parts.push(current);
        union = new Map();
        total = 2000;
        extra = 0;
        for (const size of footprint.values()) extra += size;
      }
      for (const [id, size] of footprint) union.set(id, size);
      current.pages.push(i);
      total += extra;
      current.estimatedBytes = total;
      if (current.pages.length === 1 && total > maxBytes) current.oversize = true;
    }
  } else throw new Error('Unknown split mode.');
  return parts;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
}

export function nameParts(parts: SplitPart[], options: SplitOptions): SplitPart[] {
  const base = safeFileName((options.baseName ?? 'Document').replace(/\.pdf$/i, ''), 'Document');
  const pattern = options.pattern?.trim() || (options.mode === 'bookmarks' ? '{bookmark}' : '{name} - part {n}');
  const width = String(parts.length).length;
  const names = parts.map((part, i) => {
    const raw = pattern.replace(/\{(name|n|bookmark|first|last)\}/g, (_, token: string) => {
      if (token === 'name') return base;
      if (token === 'n') return String(i + 1).padStart(width, '0');
      if (token === 'bookmark') return part.bookmark || base;
      if (token === 'first') return String(part.pages[0] + 1);
      return String(part.pages[part.pages.length - 1] + 1);
    });
    return safeFileName(raw, `${base} - part ${i + 1}`);
  });
  const unique = uniqueNames(names);
  return parts.map((part, i) => ({ ...part, name: unique[i] }));
}

export { num };
