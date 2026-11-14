/**
 * Page geometry: crop (page boxes, optional permanent removal through MuPDF redaction), automatic
 * white-margin detection, resize to a new page size, N-up sheets and blank-page detection.
 * All coordinates given by callers are "visual": as the page is displayed (after /Rotate), in
 * points, with margins measured inward from the visible page edge.
 */
import * as mupdf from 'mupdf';
import { parseContent } from '@garnet/pdf-content';
import {
  concat, contentStreams, cropBox, decodedContent, fmt, matrixString, mediaBox, newArrayOf, pageRotation, pageToVisual, rectOf, transformRect,
  visualSize, visualToPage, type Doc, type Matrix, type Obj, type Rect, type Rotation,
} from './pdf';

export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const PAPER_SIZES: Record<string, [number, number]> = {
  A3: [842, 1191],
  A4: [595, 842],
  A5: [420, 595],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
  B5: [499, 709],
};

function validMargins(m: Margins): void {
  for (const value of [m.left, m.right, m.top, m.bottom]) if (!Number.isFinite(value) || value < 0) throw new Error('Margins must be zero or more.');
}

/** The new crop box (default user space) for visual margins measured from the current crop box. */
export function cropFromMargins(page: Obj, margins: Margins): Rect {
  validMargins(margins);
  const rotation = pageRotation(page);
  const box = cropBox(page);
  const [vw, vh] = visualSize(page);
  if (margins.left + margins.right >= vw - 3 || margins.top + margins.bottom >= vh - 3) throw new Error('The crop leaves nothing of the page.');
  const visual: Rect = [margins.left, margins.bottom, vw - margins.right, vh - margins.top];
  return transformRect(visual, visualToPage(rotation, box));
}

/** Content stream q/Q balance: guards needed before, and closers needed after, to wrap it safely. */
export function contentBalance(page: Obj): { guards: number; depth: number; inText: boolean } {
  let depth = 0, min = 0, inText = false;
  try {
    for (const op of parseContent(decodedContent(page)).operations) {
      if (op.operator === 'q') depth++;
      else if (op.operator === 'Q') { depth--; if (depth < min) min = depth; }
      else if (op.operator === 'BT') inText = true;
      else if (op.operator === 'ET') inText = false;
    }
  } catch {
    return { guards: 4, depth: 0, inText: false };
  }
  return { guards: -min, depth, inText };
}

/** Wraps the page content: `before` runs first, then the original content isolated by guards. */
export function wrapContent(pdf: Doc, page: Obj, before: string, after = ''): void {
  const { guards, depth, inText } = contentBalance(page);
  const head = pdf.addStream(`q\n${before}\n${'q\n'.repeat(guards)}`, {});
  const tail = pdf.addStream(`${inText ? 'ET\n' : ''}${'Q\n'.repeat(Math.max(0, guards + depth))}Q\n${after}`, {});
  const array = pdf.newArray();
  array.push(head);
  for (const stream of contentStreams(page)) array.push(stream);
  array.push(tail);
  page.put('Contents', array);
}

function transformPoints(pdf: Doc, array: Obj, m: Matrix): Obj {
  const values: number[] = [];
  for (let i = 0; i + 1 < array.length; i += 2) {
    const x = array.get(i).asNumber(), y = array.get(i + 1).asNumber();
    values.push(x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]);
  }
  return newArrayOf(pdf, values);
}

/** Moves annotation geometry along with page content transformed by `m`. */
export function transformAnnotations(pdf: Doc, page: Obj, m: Matrix): void {
  const annots = page.get('Annots');
  if (!annots.isArray()) return;
  for (let i = 0; i < annots.length; i++) {
    const annot = annots.get(i);
    if (!annot.isDictionary()) continue;
    const rect = rectOf(annot.get('Rect'));
    if (rect) annot.put('Rect', newArrayOf(pdf, transformRect(rect, m)));
    for (const key of ['QuadPoints', 'Vertices', 'L', 'CL']) {
      const value = annot.get(key);
      if (value.isArray()) annot.put(key, transformPoints(pdf, value, m));
    }
    const ink = annot.get('InkList');
    if (ink.isArray()) {
      const list = pdf.newArray();
      for (let k = 0; k < ink.length; k++) list.push(transformPoints(pdf, ink.get(k), m));
      annot.put('InkList', list);
    }
  }
}

export function cropPage(pdf: Doc, index: number, box: Rect, removeContent: boolean): void {
  const page = pdf.findPage(index);
  const media = mediaBox(page);
  const crop: Rect = [Math.max(box[0], media[0]), Math.max(box[1], media[1]), Math.min(box[2], media[2]), Math.min(box[3], media[3])];
  if (crop[2] - crop[0] < 3 || crop[3] - crop[1] < 3) throw new Error('The crop leaves nothing of the page.');
  if (removeContent) {
    const loaded = pdf.loadPage(index);
    try {
      const ctm = loaded.getTransform() as Matrix;
      const bands: Rect[] = [
        [media[0] - 1, media[1] - 1, crop[0], media[3] + 1],
        [crop[2], media[1] - 1, media[2] + 1, media[3] + 1],
        [crop[0], media[1] - 1, crop[2], crop[1]],
        [crop[0], crop[3], crop[2], media[3] + 1],
      ].filter((b) => b[2] - b[0] > 0.01 && b[3] - b[1] > 0.01) as Rect[];
      for (const band of bands) {
        const annot = loaded.createAnnotation('Redact');
        annot.setRect(transformRect(band, ctm));
      }
      if (bands.length) loaded.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    } finally {
      loaded.destroy();
    }
    const target = pdf.findPage(index);
    target.put('MediaBox', newArrayOf(pdf, crop));
    for (const key of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) if (!target.get(key).isNull()) target.delete(key);
    return;
  }
  page.put('CropBox', newArrayOf(pdf, crop));
  for (const key of ['BleedBox', 'TrimBox', 'ArtBox']) {
    const value = rectOf(page.get(key));
    if (value) page.put(key, newArrayOf(pdf, [Math.max(value[0], crop[0]), Math.max(value[1], crop[1]), Math.min(value[2], crop[2]), Math.min(value[3], crop[3])]));
  }
}

/** Visual margins of white space around page content, from a low-resolution render. */
export function detectMargins(pdf: Doc, index: number, padding = 6): Margins | null {
  const page = pdf.loadPage(index);
  const scale = 0.5;
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
  try {
    const w = pixmap.getWidth(), h = pixmap.getHeight(), n = pixmap.getNumberOfComponents(), stride = pixmap.getStride();
    const pixels = pixmap.getPixels();
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      for (let x = 0; x < w; x++) {
        if (pixels[row + x * n] < 245) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const [vw, vh] = visualSize(pdf.findPage(index));
    const clamp = (v: number) => Math.max(0, Math.round(v * 10) / 10);
    return {
      left: clamp(x0 / scale - padding),
      top: clamp(y0 / scale - padding),
      right: clamp(vw - (x1 + 1) / scale - padding),
      bottom: clamp(vh - (y1 + 1) / scale - padding),
    };
  } finally {
    pixmap.destroy();
    page.destroy();
  }
}

export type ResizeMode = 'fit' | 'centre';

/** Gives the page a new visual size; content is scaled to fit (or centred unscaled), the old
 * visible area is clipped so hidden content outside the crop box does not appear. */
export function resizePage(pdf: Doc, index: number, size: [number, number], mode: ResizeMode): void {
  const [W, H] = size;
  if (!(W >= 3 && H >= 3 && W <= 14400 && H <= 14400)) throw new Error('Page size must be between 3 and 14,400 points.');
  const page = pdf.findPage(index);
  const rotation = pageRotation(page);
  const box = cropBox(page);
  const w = box[2] - box[0], h = box[3] - box[1];
  const [Wu, Hu] = rotation % 180 ? [H, W] : [W, H];
  const s = mode === 'fit' ? Math.min(Wu / w, Hu / h) : 1;
  const m: Matrix = [s, 0, 0, s, (Wu - s * w) / 2 - s * box[0], (Hu - s * h) / 2 - s * box[1]];
  wrapContent(pdf, page, `${matrixString(m)} cm ${fmt(box[0])} ${fmt(box[1])} ${fmt(w)} ${fmt(h)} re W n`);
  transformAnnotations(pdf, page, m);
  page.put('MediaBox', newArrayOf(pdf, [0, 0, Wu, Hu]));
  for (const key of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) if (!page.get(key).isNull()) page.delete(key);
}

export interface NUpOptions {
  perSheet: 2 | 4 | 6 | 9;
  /** Portrait paper size in points; default: the first page's size. */
  sheet?: [number, number];
  orientation?: 'auto' | 'portrait' | 'landscape';
  order?: 'across' | 'down';
  margin?: number;
  gap?: number;
  border?: boolean;
}

export function nUpLayout(perSheet: number, landscape: boolean): { cols: number; rows: number } {
  if (perSheet === 2) return landscape ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
  if (perSheet === 4) return { cols: 2, rows: 2 };
  if (perSheet === 6) return landscape ? { cols: 3, rows: 2 } : { cols: 2, rows: 3 };
  if (perSheet === 9) return { cols: 3, rows: 3 };
  throw new Error('Choose 2, 4, 6 or 9 pages per sheet.');
}

/** Builds a new document with several source pages per sheet (pages drawn as form XObjects). */
export function nUp(source: Doc, indices: readonly number[], options: NUpOptions): Doc {
  const refs = indices.map((i) => source.findPage(i));
  if (!refs.length) throw new Error('Choose at least one page.');
  const [fw, fh] = visualSize(refs[0]);
  const portraitSource = fh >= fw;
  const base = options.sheet ?? [Math.min(fw, fh), Math.max(fw, fh)];
  const short = Math.min(base[0], base[1]), long = Math.max(base[0], base[1]);
  const orientation = options.orientation ?? 'auto';
  const landscape = orientation === 'landscape' || (orientation === 'auto' && ((options.perSheet === 2 || options.perSheet === 6) ? portraitSource : !portraitSource));
  const [SW, SH] = landscape ? [long, short] : [short, long];
  const { cols, rows } = nUpLayout(options.perSheet, landscape);
  const margin = Math.max(0, options.margin ?? 18), gap = Math.max(0, options.gap ?? 12);
  const cellW = (SW - 2 * margin - (cols - 1) * gap) / cols;
  const cellH = (SH - 2 * margin - (rows - 1) * gap) / rows;
  if (cellW < 10 || cellH < 10) throw new Error('Margins and gaps leave no room for pages.');
  const out = new mupdf.PDFDocument();
  try {
    const map = out.newGraftMap();
    try {
      for (let start = 0; start < refs.length; start += options.perSheet) {
        const xobjects = out.newDictionary();
        let content = '';
        refs.slice(start, start + options.perSheet).forEach((src, k) => {
          const rotation = pageRotation(src);
          const box = cropBox(src);
          const [vw, vh] = visualSize(src);
          const dict = out.newDictionary();
          dict.put('Type', out.newName('XObject'));
          dict.put('Subtype', out.newName('Form'));
          dict.put('BBox', newArrayOf(out, box));
          dict.put('Matrix', newArrayOf(out, pageToVisual(rotation, box)));
          const resources = src.getInheritable('Resources');
          dict.put('Resources', resources.isNull() ? out.newDictionary() : map.graftObject(resources));
          const group = src.get('Group');
          if (!group.isNull()) dict.put('Group', map.graftObject(group));
          const form = out.addStream(decodedContent(src), dict);
          const name = `P${k}`;
          xobjects.put(name, form);
          const col = options.order === 'down' ? Math.floor(k / rows) : k % cols;
          const row = options.order === 'down' ? k % rows : Math.floor(k / cols);
          const x = margin + col * (cellW + gap);
          const y = SH - margin - (row + 1) * cellH - row * gap;
          const s = Math.min(cellW / vw, cellH / vh);
          const tx = x + (cellW - s * vw) / 2, ty = y + (cellH - s * vh) / 2;
          content += `q ${matrixString([s, 0, 0, s, tx, ty])} cm /${name} Do Q\n`;
          if (options.border) content += `q 0.5 w 0.6 G ${fmt(tx)} ${fmt(ty)} ${fmt(s * vw)} ${fmt(s * vh)} re S Q\n`;
        });
        const resources = out.newDictionary();
        resources.put('XObject', xobjects);
        out.insertPage(out.countPages(), out.addPage([0, 0, SW, SH], 0, resources, content));
      }
    } finally {
      map.destroy();
    }
    return out;
  } catch (error) {
    out.destroy();
    throw error;
  }
}

export interface BlankCandidate {
  index: number;
  ink: number;
  hasText: boolean;
  annotations: number;
}

/** Ink coverage (share of non-white pixels) from a small render, plus text and annotation counts. */
export function inspectBlank(pdf: Doc, index: number): BlankCandidate {
  const page = pdf.loadPage(index);
  try {
    const scale = 0.25;
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
    let dark = 0, total = 0;
    try {
      const w = pixmap.getWidth(), h = pixmap.getHeight(), n = pixmap.getNumberOfComponents(), stride = pixmap.getStride();
      const pixels = pixmap.getPixels();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { total++; if (pixels[y * stride + x * n] < 230) dark++; }
    } finally {
      pixmap.destroy();
    }
    const st = page.toStructuredText('preserve-whitespace');
    const hasText = /\S/.test(st.asText());
    st.destroy();
    return { index, ink: total ? dark / total : 0, hasText, annotations: page.getAnnotations().length };
  } finally {
    page.destroy();
  }
}

export type { Rotation };
export { concat };
