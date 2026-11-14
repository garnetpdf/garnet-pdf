import * as mupdf from 'mupdf';
import { flattenObjects, interpretPage, parseContent, serializeContent, transformRect, type PDFValue } from '@garnet/pdf-content';
import type { Quad, Rect } from '../../../shared/engine-api';
import { insideQuad, intersects, quadBounds, quadCenter, rectQuad } from './geometry';

export interface ApplyOptions {
  blackBoxes: boolean;
  /** Text drawn inside each redacted area; Latin letters only. */
  overlayText?: string;
  images: 'none' | 'pixels' | 'remove';
  lineArt: 'none' | 'covered' | 'touched';
  /** Remove comments and form fields that overlap a mark. */
  removeAnnotations: boolean;
}
export interface MarkArea {
  rect: Rect;
  quads: Quad[];
}
export interface Residual {
  pageIndex: number;
  text: string;
  source: 'extraction' | 'content';
}

const IMAGE_METHOD = { none: 0, remove: 1, pixels: 2 } as const;
const LINE_ART_METHOD = { none: 0, covered: 1, touched: 2 } as const;

export function lineTextAndQuads(page: mupdf.PDFPage) {
  const stext = page.toStructuredText('preserve-whitespace');
  const lines: { text: string; direction: [number, number]; chars: { start: number; end: number; c: string; quad: Quad }[] }[] = [];
  let line: (typeof lines)[number] | undefined;
  try {
    stext.walk({
      beginLine(_bbox, _wmode, direction) { line = { text: '', direction, chars: [] }; },
      onChar(c, _origin, _font, _size, quad) {
        if (!line) return;
        const start = line.text.length;
        line.text += c;
        line.chars.push({ start, end: line.text.length, c, quad });
      },
      endLine() { if (line) lines.push(line); line = undefined; },
    });
  } finally { stext.destroy(); }
  return lines;
}

export function redactAnnotations(page: mupdf.PDFPage): mupdf.PDFAnnotation[] {
  return page.getAnnotations().filter(annot => annot.getType() === 'Redact');
}

export function markArea(annot: mupdf.PDFAnnotation): MarkArea {
  const rect = annot.getBounds();
  let quads: Quad[] = [];
  try { if (annot.hasQuadPoints()) quads = annot.getQuadPoints(); } catch { quads = []; }
  return { rect, quads };
}

export function insideArea(x: number, y: number, area: MarkArea): boolean {
  if (area.quads.length) return area.quads.some(q => insideQuad(x, y, q));
  return x >= area.rect[0] && x <= area.rect[2] && y >= area.rect[1] && y <= area.rect[3];
}

function areaBoxes(area: MarkArea): Rect[] {
  return area.quads.length ? area.quads.map(quadBounds) : [area.rect];
}

function annotsArray(pageObject: mupdf.PDFObject) {
  const annots = pageObject.get('Annots');
  return annots.isArray() ? annots : null;
}

function rectOf(dict: mupdf.PDFObject, pageTransform: mupdf.Matrix): Rect | null {
  const rect = dict.get('Rect');
  if (!rect.isArray() || rect.length < 4) return null;
  const user: Rect = [rect.get(0).asNumber(), rect.get(1).asNumber(), rect.get(2).asNumber(), rect.get(3).asNumber()];
  return mupdf.Rect.transform(user, pageTransform) as Rect;
}

function removeFieldReference(pdf: mupdf.PDFDocument, widget: mupdf.PDFObject) {
  const form = pdf.getTrailer().get('Root').get('AcroForm');
  const removeFrom = (array: mupdf.PDFObject, num: number) => {
    if (!array.isArray()) return;
    for (let i = array.length - 1; i >= 0; i--) if (array.get(i).isIndirect() && array.get(i).asIndirect() === num) array.delete(i);
  };
  let node = widget;
  for (let depth = 0; depth < 32 && node.isIndirect(); depth++) {
    const num = node.asIndirect();
    const parent = node.get('Parent');
    if (form.isDictionary()) removeFrom(form.get('CO'), num);
    if (parent.isIndirect()) {
      const kids = parent.get('Kids');
      removeFrom(kids, num);
      if (kids.isArray() && kids.length > 0) return;
      node = parent;
    } else {
      if (form.isDictionary()) removeFrom(form.get('Fields'), num);
      return;
    }
  }
}

/** Removes comments and form fields overlapping the marks (MuPDF leaves most of them). */
function removeOverlappingAnnotations(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, areas: MarkArea[]): number {
  const pageObject = page.getObject();
  const annots = annotsArray(pageObject);
  if (!annots) return 0;
  const transform = page.getTransform();
  const boxes = areas.flatMap(areaBoxes);
  const doomed = new Set<number>();
  const widgets: mupdf.PDFObject[] = [];
  for (let i = 0; i < annots.length; i++) {
    const ref = annots.get(i);
    const dict = ref.resolve();
    const subtype = dict.get('Subtype').isName() ? dict.get('Subtype').asName() : '';
    if (subtype === 'Redact' || subtype === 'Popup') continue;
    const rect = rectOf(dict, transform);
    if (!rect || !boxes.some(box => intersects(box, rect))) continue;
    if (ref.isIndirect()) doomed.add(ref.asIndirect());
    const popup = dict.get('Popup');
    if (popup.isIndirect()) doomed.add(popup.asIndirect());
    if (subtype === 'Widget') widgets.push(ref);
  }
  if (!doomed.size) return 0;
  for (let i = annots.length - 1; i >= 0; i--) {
    const ref = annots.get(i);
    if (!ref.isIndirect()) continue;
    const parent = ref.resolve().get('Parent');
    if (doomed.has(ref.asIndirect()) || (parent.isIndirect() && doomed.has(parent.asIndirect()) && ref.resolve().get('Subtype').asName() === 'Popup')) annots.delete(i);
  }
  for (const widget of widgets) removeFieldReference(pdf, widget);
  return doomed.size;
}

function latin1(text: string): string {
  return [...text].map(ch => {
    const code = ch.codePointAt(0) || 0;
    return (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? ch : '?';
  }).join('');
}

function hexString(text: string): string {
  return `<${[...text].map(ch => (ch.codePointAt(0) || 63).toString(16).padStart(2, '0')).join('')}>`;
}

let helvetica: mupdf.Font | null = null;
function textWidth(text: string): number {
  helvetica ??= new mupdf.Font('Helvetica');
  let width = 0;
  for (const ch of text) width += helvetica.advanceGlyph(helvetica.encodeCharacter(ch.codePointAt(0) || 63), 0);
  return width;
}

function fmt(n: number) {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0';
}

/** Appends overlay text centred in each area, along the direction of the marked text. Areas are in MuPDF page space. */
function drawOverlayText(pdf: mupdf.PDFDocument, page: mupdf.PDFPage, areas: MarkArea[], text: string, white: boolean): void {
  const value = latin1(text).trim();
  if (!value) return;
  const pageObject = page.getObject();
  let ownResources = pageObject.get('Resources');
  if (!ownResources.isDictionary()) {
    const inherited = pageObject.getInheritable('Resources');
    ownResources = inherited.isDictionary() ? pdf.addObject(pdf.graftObject(inherited)) : pdf.addObject(pdf.newDictionary());
    pageObject.put('Resources', ownResources);
  }
  let fonts = ownResources.get('Font');
  if (!fonts.isDictionary()) { fonts = pdf.newDictionary(); ownResources.put('Font', fonts); }
  let name = 'GarnetRedact';
  for (let i = 1; !fonts.get(name).isNull(); i++) name = `GarnetRedact${i}`;
  helvetica ??= new mupdf.Font('Helvetica');
  fonts.put(name, pdf.addSimpleFont(helvetica, 'Latin'));
  const inverse = mupdf.Matrix.invert(page.getTransform());
  const user = (x: number, y: number) => [x * inverse[0] + y * inverse[2] + inverse[4], x * inverse[1] + y * inverse[3] + inverse[5]];
  const advance = textWidth(value);
  let content = 'q\n';
  for (const area of areas) {
    for (const q of area.quads.length ? area.quads : [rectQuad(area.rect)]) {
      const ul = [q[0], q[1]], ur = [q[2], q[3]], ll = [q[4], q[5]], lr = [q[6], q[7]];
      const w = Math.hypot(ur[0] - ul[0], ur[1] - ul[1]), h = Math.hypot(ul[0] - ll[0], ul[1] - ll[1]);
      if (w < 2 || h < 2) continue;
      const d = [(ur[0] - ul[0]) / w, (ur[1] - ul[1]) / w], u = [(ul[0] - ll[0]) / h, (ul[1] - ll[1]) / h];
      let size = Math.min(h * 0.72, 11);
      if (advance * size > w * 0.92) size = (w * 0.92) / advance;
      if (size < 3) continue;
      const along = (w - advance * size) / 2, up = h / 2 - size * 0.35;
      const origin = [ll[0] + d[0] * along + u[0] * up, ll[1] + d[1] * along + u[1] * up];
      const tm = mupdf.Matrix.concat([d[0], d[1], u[0], u[1], origin[0], origin[1]], inverse);
      const clip = [ul, ur, lr, ll].map(([x, y]) => user(x, y).map(fmt).join(' '));
      content += `q ${clip[0]} m ${clip[1]} l ${clip[2]} l ${clip[3]} l h W n BT ${white ? '1 g' : '0 g'} /${name} ${fmt(size)} Tf ${tm.map(fmt).join(' ')} Tm ${hexString(value)} Tj ET Q\n`;
    }
  }
  content += 'Q\n';
  const stream = pdf.addStream(content, {});
  const contents = pageObject.get('Contents');
  if (contents.isArray()) contents.push(stream);
  else {
    const array = pdf.newArray();
    if (!contents.isNull()) array.push(contents);
    array.push(stream);
    pageObject.put('Contents', array);
  }
}

const SHOW = new Set(['Tj', 'TJ', "'", '"']);
const encoder = new TextEncoder();

function isString(value: PDFValue | undefined): value is { type: 'string'; bytes: Uint8Array } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.type === 'string');
}

function hex(bytes: Uint8Array) {
  return `<${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}>`;
}

/**
 * MuPDF 1.28.6 loses the advance of the first removed glyph when removal starts in the middle of a
 * string, so the rest of the line shifts left. Splitting the strings of affected text operators into
 * one string per glyph beforehand keeps every remaining glyph exactly where it was.
 */
export function splitStringsUnderMarks(pdf: mupdf.PDFDocument, pageIndex: number, areas: MarkArea[]): number {
  const boxes = areas.flatMap(areaBoxes);
  const model = interpretPage(pdf, pageIndex);
  const runs = model.objects.filter(object => object.kind === 'text');
  const pageObject = pdf.findPage(pageIndex);
  const contents = pageObject.get('Contents');
  const refs = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
  const streams = refs.filter(ref => ref.isStream()).map(ref => {
    const raw = ref.readStream();
    const parsed = parseContent(new Uint8Array(raw.asUint8Array()));
    raw.destroy();
    return { ref, parsed, changed: false };
  });
  const shows = streams.flatMap(stream => stream.parsed.operations.filter(op => SHOW.has(op.operator)).map(op => ({ stream, op })));
  if (shows.length !== runs.length) return 0;
  let split = 0;
  runs.forEach((run, index) => {
    if (run.kind !== 'text' || run.glyphs.length < 2 || !boxes.some(box => intersects(box, run.pageBBox))) return;
    const { stream, op } = shows[index];
    const operand = op.operands.at(-1);
    const parts = Array.isArray(operand) ? operand : [operand];
    let glyph = 0;
    const out: string[] = [];
    for (const part of parts) {
      if (typeof part === 'number') { out.push(String(part)); continue; }
      if (!isString(part)) return;
      let offset = 0;
      while (offset < part.bytes.length) {
        const length = run.glyphs[glyph]?.byteLength ?? 0;
        if (length <= 0 || offset + length > part.bytes.length) return;
        out.push(hex(part.bytes.subarray(offset, offset + length)));
        offset += length;
        glyph++;
      }
    }
    if (glyph !== run.glyphs.length) return;
    const n = op.operands;
    const prefix = op.operator === "'" ? 'T* ' : op.operator === '"' && typeof n[0] === 'number' && typeof n[1] === 'number' ? `${n[0]} Tw ${n[1]} Tc T* ` : op.operator === '"' ? null : '';
    if (prefix === null) return;
    op.replacement = encoder.encode(`${prefix}[${out.join(' ')}] TJ`);
    stream.changed = true;
    split++;
  });
  for (const stream of streams) if (stream.changed) stream.ref.writeStream(serializeContent(stream.parsed));
  pageObject.destroy();
  return split;
}

/** Applies every redaction mark on one page. Returns the mark areas (page space) for verification. */
export function applyPage(pdf: mupdf.PDFDocument, pageIndex: number, options: ApplyOptions): { areas: MarkArea[]; removedAnnotations: number } {
  let page = pdf.loadPage(pageIndex);
  try {
    const marks = redactAnnotations(page);
    if (!marks.length) return { areas: [], removedAnnotations: 0 };
    const areas = marks.map(markArea);
    page.destroy();
    splitStringsUnderMarks(pdf, pageIndex, areas);
    page = pdf.loadPage(pageIndex);
    page.applyRedactions(options.blackBoxes, IMAGE_METHOD[options.images], LINE_ART_METHOD[options.lineArt], mupdf.PDFPage.REDACT_TEXT_REMOVE);
    page.destroy();
    page = pdf.loadPage(pageIndex);
    const removedAnnotations = options.removeAnnotations ? removeOverlappingAnnotations(pdf, page, areas) : 0;
    return { areas, removedAnnotations };
  } finally {
    page.destroy();
  }
}

/** Draws the overlay text after verification, so the label itself is never mistaken for leftover text. */
export function overlayPage(pdf: mupdf.PDFDocument, pageIndex: number, areas: MarkArea[], options: ApplyOptions): void {
  if (!options.overlayText?.trim() || !areas.length) return;
  const page = pdf.loadPage(pageIndex);
  try { drawOverlayText(pdf, page, areas, options.overlayText, options.blackBoxes); } finally { page.destroy(); }
}

/** Looks for text left under the areas, in extracted text and in the decoded content streams. */
export function residualText(pdf: mupdf.PDFDocument, pageIndex: number, areas: MarkArea[]): Residual[] {
  const residuals: Residual[] = [];
  const page = pdf.loadPage(pageIndex);
  try {
    let found = '';
    for (const line of lineTextAndQuads(page)) {
      for (const char of line.chars) {
        const [x, y] = quadCenter(char.quad);
        if (char.c.trim() && areas.some(area => insideArea(x, y, area))) found += char.c;
      }
    }
    if (found) residuals.push({ pageIndex, text: found, source: 'extraction' });
  } finally { page.destroy(); }
  const model = interpretPage(pdf, pageIndex);
  let content = '';
  for (const object of flattenObjects(model.objects)) {
    if (object.kind !== 'text') continue;
    for (const glyph of object.glyphs) {
      const box = transformRect(glyph.bbox, model.userToPage);
      const x = (box[0] + box[2]) / 2, y = (box[1] + box[3]) / 2;
      if (glyph.unicode.trim() && areas.some(area => insideArea(x, y, area))) content += glyph.unicode;
    }
  }
  if (content) residuals.push({ pageIndex, text: content, source: 'content' });
  return residuals;
}
