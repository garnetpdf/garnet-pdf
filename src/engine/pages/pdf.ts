/**
 * Low-level PDF object helpers for page operations: page references, destinations, name trees,
 * outline trees and page geometry. Everything here runs inside a journaled MuPDF operation
 * opened by the caller; nothing here begins or ends operations itself.
 */
import type * as mupdf from 'mupdf';
import { concat, invert, point, transformRect } from '@garnet/pdf-content';
import type { Matrix, Rect } from '@garnet/pdf-content';

export type Obj = mupdf.PDFObject;
export type Doc = mupdf.PDFDocument;

export function pageRefs(pdf: Doc): Obj[] {
  const count = pdf.countPages();
  const refs: Obj[] = new Array(count);
  for (let i = 0; i < count; i++) refs[i] = pdf.findPage(i);
  return refs;
}

export function num(obj: Obj): number {
  return obj.isIndirect() ? obj.asIndirect() : 0;
}

export function pageIndexByNum(refs: readonly Obj[]): Map<number, number> {
  const map = new Map<number, number>();
  refs.forEach((ref, index) => map.set(ref.asIndirect(), index));
  return map;
}

export function str(obj: Obj): string {
  if (obj.isString()) return obj.asString();
  if (obj.isName()) return obj.asName();
  return '';
}

export function numberOr(obj: Obj, fallback: number): number {
  return obj.isNumber() ? obj.asNumber() : fallback;
}

export function rectOf(obj: Obj): Rect | null {
  if (!obj.isArray() || obj.length < 4) return null;
  const v = [0, 1, 2, 3].map((i) => numberOr(obj.get(i), NaN));
  if (!v.every(Number.isFinite)) return null;
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

export function newArrayOf(pdf: Doc, values: readonly (number | Obj)[]): Obj {
  const array = pdf.newArray();
  for (const value of values) array.push(typeof value === 'number' ? roundNumber(value) : value);
  return array;
}

export function roundNumber(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function fmt(value: number): string {
  return String(roundNumber(value));
}

export function matrixString(m: Matrix): string {
  return m.map(fmt).join(' ');
}

/** Named destinations from the /Names /Dests tree and the PDF 1.1 /Dests dictionary. */
export class NamedDests {
  private cache?: Map<string, Obj>;
  constructor(private readonly pdf: Doc) {}

  get(name: string): Obj | undefined {
    if (!this.cache) {
      this.cache = new Map();
      const root = this.pdf.getTrailer().get('Root');
      const old = root.get('Dests');
      if (old.isDictionary()) old.forEach((value, key) => this.cache!.set(String(key), value));
      const tree = root.get('Names', 'Dests');
      if (tree.isDictionary()) walkNameTree(tree, (key, value) => this.cache!.set(key, value));
    }
    return this.cache.get(name);
  }
}

/** Resolves a destination (array, name, string or dest dictionary) to the target page object number. */
export function destPageNum(dest: Obj, named: NamedDests, refs: readonly Obj[], depth = 0): number | null {
  if (depth > 8 || dest.isNull()) return null;
  let d = dest.isIndirect() ? dest.resolve() : dest;
  if (d.isName() || d.isString()) {
    const target = named.get(d.isName() ? d.asName() : d.asString());
    if (!target) return null;
    return destPageNum(target, named, refs, depth + 1);
  }
  if (d.isDictionary()) d = d.get('D');
  if (d.isIndirect()) d = d.resolve();
  if (!d.isArray() || d.length < 1) return null;
  const page = d.get(0);
  if (page.isIndirect()) return page.asIndirect();
  if (page.isNumber()) {
    const index = page.asNumber();
    return Number.isInteger(index) && index >= 0 && index < refs.length ? refs[index].asIndirect() : null;
  }
  return null;
}

/** The explicit destination array behind a destination (resolving names), or null. */
export function destArray(dest: Obj, named: NamedDests, depth = 0): Obj | null {
  if (depth > 8 || dest.isNull()) return null;
  let d = dest.isIndirect() ? dest.resolve() : dest;
  if (d.isName() || d.isString()) {
    const target = named.get(d.isName() ? d.asName() : d.asString());
    return target ? destArray(target, named, depth + 1) : null;
  }
  if (d.isDictionary()) d = d.get('D');
  if (d.isIndirect()) d = d.resolve();
  return d.isArray() ? d : null;
}

/** Destination used by an outline item or link annotation: /Dest, or /A of type GoTo. */
export function itemDest(item: Obj): Obj | null {
  const dest = item.get('Dest');
  if (!dest.isNull()) return dest;
  const action = item.get('A');
  if (action.isDictionary() && action.get('S').isName() && action.get('S').asName() === 'GoTo') return action.get('D');
  return null;
}

export function walkNameTree(node: Obj, fn: (key: string, value: Obj, leaf: Obj, index: number) => void, depth = 0, seen = new Set<number>()): void {
  if (depth > 32) return;
  const id = num(node);
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  const names = node.get('Names');
  if (names.isArray()) {
    for (let i = 0; i + 1 < names.length; i += 2) fn(str(names.get(i)), names.get(i + 1), names, i);
  }
  const kids = node.get('Kids');
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) walkNameTree(kids.get(i), fn, depth + 1, seen);
}

/** Removes name-tree entries for which keep() is false. Returns the number removed. */
export function filterNameTree(pdf: Doc, node: Obj, keep: (key: string, value: Obj) => boolean, depth = 0, seen = new Set<number>()): number {
  if (depth > 32) return 0;
  const id = num(node);
  if (id) {
    if (seen.has(id)) return 0;
    seen.add(id);
  }
  let removed = 0;
  const names = node.get('Names');
  if (names.isArray()) {
    const kept: Obj[] = [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      if (keep(str(names.get(i)), names.get(i + 1))) kept.push(names.get(i), names.get(i + 1));
      else removed++;
    }
    if (removed) node.put('Names', newArrayOf(pdf, kept));
  }
  const kids = node.get('Kids');
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) removed += filterNameTree(pdf, kids.get(i), keep, depth + 1, seen);
  return removed;
}

export interface OutlineNode {
  ref: Obj;
  children: OutlineNode[];
}

/** Reads the outline tree (indirect item references) with cycle protection. */
export function readOutline(pdf: Doc): { root: Obj | null; items: OutlineNode[] } {
  const root = pdf.getTrailer().get('Root').get('Outlines');
  if (!root.isDictionary()) return { root: null, items: [] };
  const seen = new Set<number>();
  const readChildren = (parent: Obj, depth: number): OutlineNode[] => {
    const out: OutlineNode[] = [];
    if (depth > 64) return out;
    let item = parent.get('First');
    while (item.isDictionary()) {
      const id = num(item);
      if (!id || seen.has(id)) break;
      seen.add(id);
      out.push({ ref: item, children: readChildren(item, depth + 1) });
      item = item.get('Next');
    }
    return out;
  };
  return { root: pdf.getTrailer().get('Root').get('Outlines'), items: readChildren(root, 0) };
}

function sameRef(a: Obj, b: Obj | undefined): boolean {
  return Boolean(b) && !a.isNull() && !b!.isNull() && num(a) !== 0 && num(a) === num(b!);
}

/** Rewrites First/Last/Prev/Next/Parent links of one level, touching only entries that change. */
export function linkChildren(parent: Obj, children: readonly Obj[]): void {
  const setRef = (dict: Obj, key: string, value: Obj | undefined) => {
    const current = dict.get(key);
    if (!value) {
      if (!current.isNull()) dict.delete(key);
    } else if (!sameRef(current, value)) dict.put(key, value);
  };
  setRef(parent, 'First', children[0]);
  setRef(parent, 'Last', children[children.length - 1]);
  children.forEach((child, i) => {
    setRef(child, 'Parent', parent);
    setRef(child, 'Prev', children[i - 1]);
    setRef(child, 'Next', children[i + 1]);
  });
}

/** Recomputes /Count for the whole tree, keeping each item's open or closed state. */
export function recountOutline(root: Obj, items: readonly OutlineNode[]): void {
  const visit = (node: Obj, children: readonly OutlineNode[], isRoot: boolean): number => {
    let visible = 0;
    for (const child of children) {
      const sub = visit(child.ref, child.children, false);
      visible += 1 + (isOpen(child.ref) ? sub : 0);
    }
    const current = node.get('Count');
    if (!children.length) {
      if (!current.isNull()) node.delete('Count');
      return 0;
    }
    const value = isRoot || isOpen(node) ? visible : -visible;
    if (!current.isNumber() || current.asNumber() !== value) node.put('Count', value);
    return visible;
  };
  visit(root, items, true);
}

function isOpen(item: Obj): boolean {
  const count = item.get('Count');
  return count.isNumber() && count.asNumber() > 0;
}

export type Rotation = 0 | 90 | 180 | 270;

export function normaliseRotation(value: number): Rotation {
  const r = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

export function pageRotation(page: Obj): Rotation {
  const value = page.getInheritable('Rotate');
  return normaliseRotation(value.isNumber() ? value.asNumber() : 0);
}

export function mediaBox(page: Obj): Rect {
  return rectOf(page.getInheritable('MediaBox')) ?? [0, 0, 612, 792];
}

/** Visible area: CropBox clipped to MediaBox (PDF default user space). */
export function cropBox(page: Obj): Rect {
  const media = mediaBox(page);
  const crop = rectOf(page.getInheritable('CropBox'));
  if (!crop) return media;
  const box: Rect = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
  return box[2] > box[0] && box[3] > box[1] ? box : media;
}

/** Visible size as displayed (after /Rotate). */
export function visualSize(page: Obj): [number, number] {
  const box = cropBox(page);
  const w = box[2] - box[0], h = box[3] - box[1];
  return pageRotation(page) % 180 ? [h, w] : [w, h];
}

/**
 * Maps default user space to "visual space": origin at the bottom-left of the visible page as
 * displayed (after /Rotate), y up, units in points.
 */
export function pageToVisual(rotation: Rotation, box: Rect): Matrix {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  switch (rotation) {
    case 90: return [0, -1, 1, 0, -y0, w + x0];
    case 180: return [-1, 0, 0, -1, x0 + w, y0 + h];
    case 270: return [0, 1, -1, 0, y0 + h, -x0];
    default: return [1, 0, 0, 1, -x0, -y0];
  }
}

export function visualToPage(rotation: Rotation, box: Rect): Matrix {
  return invert(pageToVisual(rotation, box));
}

export { concat, invert, point, transformRect };
export type { Matrix, Rect };

export function decodedContent(page: Obj): Uint8Array {
  const contents = page.get('Contents');
  const parts: Uint8Array[] = [];
  const add = (stream: Obj) => {
    if (!stream.isStream()) return;
    const buffer = stream.readStream();
    try { parts.push(Uint8Array.from(buffer.asUint8Array())); } finally { buffer.destroy(); }
  };
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) add(contents.get(i));
  else add(contents);
  let length = 0;
  for (const part of parts) length += part.length + 1;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
    out[at++] = 10;
  }
  return out;
}

export function contentStreams(page: Obj): Obj[] {
  const contents = page.get('Contents');
  const out: Obj[] = [];
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) out.push(contents.get(i));
  else if (!contents.isNull()) out.push(contents);
  return out;
}

/** Fast FNV-1a hash, used for thumbnail fingerprints. */
export function hashBytes(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function hashString(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function rawStreamBytes(stream: Obj): Uint8Array {
  const buffer = stream.readRawStream();
  try { return Uint8Array.from(buffer.asUint8Array()); } finally { buffer.destroy(); }
}
