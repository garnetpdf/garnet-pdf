/**
 * One-line text layout for page stamps (headers, footers, page numbers, Bates numbers and text
 * watermarks): Unicode bidi runs (bidi-js), font fallback, HarfBuzz shaping for the bundled Noto
 * Naskh Arabic, plain advances for the PDF base-14 fonts. Output is positioned glyphs plus the
 * PDF font resources to draw them with, following the conventions of the content model's
 * insertText (embedded fonts, glyph IDs as codes, ActualText for shaped and right-to-left text so
 * text extraction returns the logical string). Font objects come from resources.ts, which avoids
 * MuPDF's reuse tables (they keep pointing at fonts removed by undo).
 */
import * as mupdf from 'mupdf';
import bidiFactory, { type Bidi } from 'bidi-js';
import type { HarfBuzz } from 'harfbuzzjs/hbjs.js';
import notoNaskhUrl from './fonts/NotoNaskhArabic-Regular.ttf?url';
import type { Doc, Obj } from './pdf';
import { fingerprint, freshFont } from './resources';

export type FontFamily = 'Helvetica' | 'Times' | 'Courier' | 'Noto Naskh Arabic';
export const FONT_FAMILIES: FontFamily[] = ['Helvetica', 'Times', 'Courier', 'Noto Naskh Arabic'];
export const ARABIC_FAMILY: FontFamily = 'Noto Naskh Arabic';

const BASE14: Record<string, [string, string, string, string]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

let fontBytesLoader = async (family: string): Promise<Uint8Array | null> => {
  if (family !== ARABIC_FAMILY) return null;
  const response = await fetch(notoNaskhUrl);
  if (!response.ok) throw new Error('The bundled Arabic font could not be loaded.');
  return new Uint8Array(await response.arrayBuffer());
};
/** Tests (Node) replace the browser loader, which fetches the bundled asset URL. */
export function setFontBytesLoader(loader: (family: string) => Promise<Uint8Array | null>): void {
  fontBytesLoader = loader;
  fontBytes.clear();
}
const fontBytes = new Map<string, Promise<Uint8Array | null>>();
function loadFontBytes(family: string): Promise<Uint8Array | null> {
  let pending = fontBytes.get(family);
  if (!pending) {
    pending = fontBytesLoader(family);
    fontBytes.set(family, pending);
  }
  return pending;
}

let harfbuzzPromise: Promise<HarfBuzz> | null = null;
function harfbuzz(): Promise<HarfBuzz> {
  if (!harfbuzzPromise) {
    harfbuzzPromise = (async () => {
      const [{ default: createHarfBuzz }, { default: hbjs }] = await Promise.all([import('harfbuzzjs/hb.js'), import('harfbuzzjs/hbjs.js')]);
      const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node) && typeof window === 'undefined' && typeof self === 'undefined';
      let instance: unknown;
      if (isNode) instance = await createHarfBuzz();
      else {
        const { default: wasmUrl } = await import('harfbuzzjs/hb.wasm?url');
        instance = await createHarfBuzz({ locateFile: () => wasmUrl });
      }
      return hbjs(instance);
    })();
    harfbuzzPromise.catch(() => { harfbuzzPromise = null; });
  }
  return harfbuzzPromise;
}

let bidiInstance: Bidi | null = null;
const bidi = () => (bidiInstance ??= bidiFactory());

const COMPLEX = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

export interface FontUse {
  key: string;
  /** Identifies the font file and version in the PDF, for reuse across operations. */
  tag: string;
  kind: 'simple' | 'cid';
  font: mupdf.Font;
  shaper?: { face: unknown; hbFont: unknown; upem: number };
}

export interface PositionedGlyph { code: number; x: number; y: number; advance: number }
export interface LineRun { font: FontUse; glyphs: PositionedGlyph[]; logicalStart: number; rtl: boolean }
export interface LineLayout {
  width: number;
  runs: LineRun[];
  /** Logical text for /ActualText, when glyphs alone would not extract correctly. */
  actualText: string | null;
  ascent: number;
  descent: number;
}

/** Fonts used by one stamping operation. Holds MuPDF and HarfBuzz objects; call close(). */
export class FontBook {
  private readonly fonts = new Map<string, FontUse>();
  private readonly refs = new Map<string, Obj>();
  private hb?: HarfBuzz;
  private readonly blobs: { destroy(): void }[] = [];

  async prepare(family: FontFamily, needsArabic: boolean): Promise<void> {
    if (needsArabic || family === ARABIC_FAMILY) await this.arabic();
  }

  private async arabic(): Promise<FontUse> {
    const existing = this.fonts.get(`cid:${ARABIC_FAMILY}`);
    if (existing) return existing;
    const bytes = await loadFontBytes(ARABIC_FAMILY);
    if (!bytes) throw new Error('The Arabic font is not available.');
    this.hb ??= await harfbuzz();
    const blob = this.hb.createBlob(bytes);
    const face = this.hb.createFace(blob, 0);
    const hbFont = this.hb.createFont(face);
    this.blobs.push(hbFont, face, blob);
    const key = `cid:${ARABIC_FAMILY}`;
    const use: FontUse = { key, tag: `${key}:${fingerprint(bytes)}`, kind: 'cid', font: new mupdf.Font(ARABIC_FAMILY, bytes), shaper: { face, hbFont, upem: face.upem } };
    this.fonts.set(use.key, use);
    return use;
  }

  base14(family: FontFamily, bold: boolean, italic: boolean, kind: 'simple' | 'cid'): FontUse {
    const names = BASE14[family] ?? BASE14.Helvetica;
    const name = names[(bold ? 1 : 0) + (italic ? 2 : 0)];
    const key = `${kind}:${name}`;
    let use = this.fonts.get(key);
    if (!use) {
      use = { key, tag: key, kind, font: new mupdf.Font(name) };
      this.fonts.set(key, use);
    }
    return use;
  }

  /** PDF font object for this document: one already used by a live stamp (by tag), else a new one. */
  ref(pdf: Doc, use: FontUse, live?: () => ReadonlyMap<string, Obj>): Obj {
    let ref = this.refs.get(use.key);
    if (!ref) {
      ref = live?.().get(use.tag) ?? freshFont(pdf, use.font, use.kind, use.tag);
      this.refs.set(use.key, ref);
    }
    return ref;
  }

  layout(text: string, family: FontFamily, size: number, options: { bold?: boolean; italic?: boolean; direction?: 'auto' | 'ltr' | 'rtl' } = {}): LineLayout {
    const bold = Boolean(options.bold), italic = Boolean(options.italic);
    if (!text) return { width: 0, runs: [], actualText: null, ascent: size * 0.8, descent: size * 0.25 };
    const arabic = this.fonts.get(`cid:${ARABIC_FAMILY}`);
    const primarySimple = family === ARABIC_FAMILY ? null : this.base14(family, bold, italic, 'simple');
    const primaryCid = family === ARABIC_FAMILY ? null : this.base14(family, bold, italic, 'cid');
    const levels = bidi().getEmbeddingLevels(text, options.direction && options.direction !== 'auto' ? options.direction : undefined);
    // Code points with their UTF-16 offsets.
    const points: { cp: number; at: number; ch: string }[] = [];
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      points.push({ cp, at: i, ch });
      i += ch.length;
    }
    const fontFor = (cp: number, ch: string): FontUse => {
      if (COMPLEX.test(ch)) {
        if (!arabic) throw new Error('Arabic text needs the Arabic font.');
        return arabic;
      }
      if (family === ARABIC_FAMILY) {
        if (arabic && arabic.font.encodeCharacter(cp)) return arabic;
        return this.base14('Helvetica', bold, italic, cp >= 0x20 && cp <= 0x7e ? 'simple' : 'cid');
      }
      if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return primarySimple!;
      if (primaryCid!.font.encodeCharacter(cp)) return primaryCid!;
      if (arabic && arabic.font.encodeCharacter(cp)) return arabic;
      throw new Error(`The font has no character for "${ch}".`);
    };
    // Visual order of code points: reverse UTF-16 positions segment by segment (UAX #9 L2).
    const units = Array.from({ length: text.length }, (_, i) => i);
    for (const [start, end] of bidi().getReorderSegments(text, levels)) {
      for (let a = start, b = end; a < b; a++, b--) [units[a], units[b]] = [units[b], units[a]];
    }
    const unitToPoint = new Map<number, number>();
    points.forEach((p, i) => unitToPoint.set(p.at, i));
    const order = units.filter((u) => unitToPoint.has(u)).map((u) => unitToPoint.get(u)!);
    // Group visually adjacent code points sharing font and direction.
    interface Group { font: FontUse; rtl: boolean; indices: number[] }
    const groups: Group[] = [];
    for (const index of order) {
      const p = points[index];
      const font = fontFor(p.cp, p.ch);
      const rtl = (levels.levels[p.at] & 1) === 1;
      const last = groups[groups.length - 1];
      if (last && last.font === font && last.rtl === rtl) last.indices.push(index);
      else groups.push({ font, rtl, indices: [index] });
    }
    let pen = 0;
    let complex = false;
    const runs: LineRun[] = [];
    for (const group of groups) {
      const glyphs: PositionedGlyph[] = [];
      const logical = [...group.indices].sort((a, b) => a - b);
      if (group.font.shaper && this.hb) {
        complex = true;
        const buffer = this.hb.createBuffer();
        try {
          buffer.addText(logical.map((i) => points[i].ch).join(''));
          buffer.guessSegmentProperties();
          buffer.setDirection(group.rtl ? 'rtl' : 'ltr');
          this.hb.shape(group.font.shaper.hbFont as never, buffer);
          const scale = size / group.font.shaper.upem;
          for (const g of buffer.json()) {
            glyphs.push({ code: g.g, x: pen + g.dx * scale, y: g.dy * scale, advance: g.ax * scale });
            pen += g.ax * scale;
          }
        } finally {
          buffer.destroy();
        }
      } else {
        if (group.rtl) complex = true;
        for (const index of group.indices) {
          let ch = points[index].ch;
          if (group.rtl) ch = bidi().getMirroredCharacter(ch) ?? ch;
          const cp = ch.codePointAt(0)!;
          const gid = group.font.font.encodeCharacter(cp);
          const advance = group.font.font.advanceGlyph(gid, 0) * size;
          glyphs.push({ code: group.font.kind === 'simple' ? cp : gid, x: pen, y: 0, advance });
          pen += advance;
        }
      }
      runs.push({ font: group.font, glyphs, logicalStart: points[logical[0]].at, rtl: group.rtl });
    }
    const hasArabic = runs.some((r) => r.font.shaper);
    return { width: pen, runs, actualText: complex ? text : null, ascent: size * (hasArabic ? 0.9 : 0.75), descent: size * (hasArabic ? 0.45 : 0.22) };
  }

  close(): void {
    for (const item of this.blobs) item.destroy();
    for (const use of this.fonts.values()) use.font.destroy();
    this.blobs.length = 0;
    this.fonts.clear();
    this.refs.clear();
  }
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

function literal(codes: number[]): string {
  let out = '(';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += `\\${String.fromCharCode(c)}`;
    else if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
    else out += `\\${c.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

export function utf16Hex(text: string): string {
  let out = '<FEFF';
  for (let i = 0; i < text.length; i++) out += hex4(text.charCodeAt(i)).toUpperCase();
  return `${out}>`;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Content operators drawing a laid-out line with its baseline origin at (x, y) in the current
 * coordinate system. Runs are painted in logical order (MuPDF applies bidi to ActualText spans).
 */
export function drawLine(layout: LineLayout, x: number, y: number, size: number, fontName: (use: FontUse) => string): string {
  if (!layout.runs.length) return '';
  let body = layout.actualText !== null ? `/Span <</ActualText ${utf16Hex(layout.actualText)}>> BDC\n` : '';
  body += 'BT\n';
  const painted = [...layout.runs].sort((a, b) => a.logicalStart - b.logicalStart);
  for (const run of painted) {
    body += `/${fontName(run.font)} ${n(size)} Tf\n`;
    if (run.font.kind === 'simple' && !run.rtl) {
      body += `1 0 0 1 ${n(x + run.glyphs[0].x)} ${n(y)} Tm ${literal(run.glyphs.map((g) => g.code))} Tj\n`;
      continue;
    }
    const glyphs = run.rtl ? [...run.glyphs].reverse() : run.glyphs;
    for (const g of glyphs) {
      const code = run.font.kind === 'simple' ? literal([g.code]) : `<${hex4(g.code)}>`;
      body += `1 0 0 1 ${n(x + g.x)} ${n(y + g.y)} Tm ${code} Tj\n`;
    }
  }
  body += 'ET\n';
  if (layout.actualText !== null) body += 'EMC\n';
  return body;
}

export function needsArabic(text: string): boolean {
  return COMPLEX.test(text);
}
