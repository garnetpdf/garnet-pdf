import * as mupdf from 'mupdf';
import type { Rect } from '../../../shared/engine-api';
import { applyPage } from '../redact/apply';

export type RGB = [number, number, number];
/** One picture drawn on the page: where (page space), its transform, its size in pixels. */
export interface Placement {
  bounds: Rect;
  ctm: mupdf.Matrix;
  width: number;
  height: number;
}
export interface ErasePlan {
  pageIndex: number;
  box: Rect;
  /** Pictures under the box before removal, with the paper colour just outside the box on each. */
  pictures: (Placement & { colour: RGB })[];
  before: Uint8Array;
}

/** Width of the band just outside the box that gives the paper colour, in points. */
const RING = 3;
const WHITE: RGB = [255, 255, 255];
/** JPEG quality for a scan whose stamp was cut out: close to how scanners save, without visible blocks. */
const JPEG_QUALITY = 85;

export function clip(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function area(rect: Rect): number {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

function overlaps(a: Rect, b: Rect): boolean {
  return area(clip(a, b)) > 0;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.every((value, i) => Math.abs(value - b[i]) < 0.01);
}

function pixelBox(rect: Rect): Rect {
  return [Math.floor(rect[0]), Math.floor(rect[1]), Math.ceil(rect[2]), Math.ceil(rect[3])];
}

/** Where pictures (including stencil masks) are drawn on the page, in MuPDF page space. */
export function imagePlacements(page: mupdf.PDFPage): Placement[] {
  const found: Placement[] = [];
  const add = (image: mupdf.Image, ctm: mupdf.Matrix) =>
    found.push({ bounds: mupdf.Rect.transform([0, 0, 1, 1], ctm) as Rect, ctm, width: image.getWidth(), height: image.getHeight() });
  const device = new mupdf.Device({ fillImage: (image, ctm) => add(image, ctm), fillImageMask: (image, ctm) => add(image, ctm) });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    device.close();
    device.destroy();
  }
  return found;
}

/** Renders one region of the page at 72 dpi on white: contents only, or with annotations. */
function renderRegion(page: mupdf.PDFPage, region: Rect, contentsOnly: boolean): { pixels: Uint8Array; box: Rect; stride: number; n: number } {
  const box = pixelBox(region);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, false);
  try {
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    try {
      if (contentsOnly) page.runPageContents(device, mupdf.Matrix.identity);
      else page.run(device, mupdf.Matrix.identity);
    } finally {
      device.close();
      device.destroy();
    }
    return { pixels: Uint8Array.from(pixmap.getPixels()), box, stride: pixmap.getStride(), n: pixmap.getNumberOfComponents() };
  } finally {
    pixmap.destroy();
  }
}

/** Median colour of the band just outside the box, limited to `within` (a picture). White when the band is empty. */
export function surroundColour(page: mupdf.PDFPage, box: Rect, within: Rect): RGB {
  const band = clip(clip([box[0] - RING, box[1] - RING, box[2] + RING, box[3] + RING], page.getBounds() as Rect), within);
  if (band[2] - band[0] < 1 || band[3] - band[1] < 1) return WHITE;
  const { pixels, box: px, stride, n } = renderRegion(page, band, true);
  const channels: number[][] = [[], [], []];
  for (let y = px[1]; y < px[3]; y++) {
    for (let x = px[0]; x < px[2]; x++) {
      const outsideBand = x < band[0] - 0.5 || x + 1 > band[2] + 0.5 || y < band[1] - 0.5 || y + 1 > band[3] + 0.5;
      const insideBox = x + 1 > box[0] && x < box[2] && y + 1 > box[1] && y < box[3];
      if (outsideBand || insideBox) continue;
      const i = (y - px[1]) * stride + (x - px[0]) * n;
      for (let k = 0; k < 3; k++) channels[k].push(pixels[i + k]);
    }
  }
  if (!channels[0].length) return WHITE;
  return channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]) as RGB;
}

/** Reads everything needed before removal: the box on this page, the pictures under it and a picture of the box. */
export function planPage(pdf: mupdf.PDFDocument, pageIndex: number, rect: Rect, minSize: number): ErasePlan | null {
  const page = pdf.loadPage(pageIndex);
  try {
    const box = clip(rect, page.getBounds() as Rect);
    if (box[2] - box[0] < minSize || box[3] - box[1] < minSize) return null;
    const pictures = imagePlacements(page)
      .filter((placement) => overlaps(placement.bounds, box))
      .map((placement) => ({ ...placement, colour: surroundColour(page, box, placement.bounds) }));
    return { pageIndex, box, pictures, before: renderRegion(page, box, false).pixels };
  } finally {
    page.destroy();
  }
}

function rectOf(dict: mupdf.PDFObject, pageTransform: mupdf.Matrix): Rect | null {
  const rect = dict.get('Rect');
  if (!rect.isArray() || rect.length < 4) return null;
  const user: Rect = [rect.get(0).asNumber(), rect.get(1).asNumber(), rect.get(2).asNumber(), rect.get(3).asNumber()];
  return mupdf.Rect.transform(user, pageTransform) as Rect;
}

function subtypeOf(dict: mupdf.PDFObject): string {
  const subtype = dict.get('Subtype');
  return subtype.isName() ? subtype.asName() : '';
}

/** Removes stamps, comments, drawings and links lying mostly inside the box, with their pop-up notes. Form fields stay. */
export function removeAnnotationsInside(pdf: mupdf.PDFDocument, pageIndex: number, box: Rect): number {
  const page = pdf.loadPage(pageIndex);
  try {
    const annots = page.getObject().get('Annots');
    if (!annots.isArray()) return 0;
    const transform = page.getTransform();
    const doomedObjects = new Set<number>();
    const doomedEntries = new Set<number>();
    for (let i = 0; i < annots.length; i++) {
      const ref = annots.get(i);
      const dict = ref.resolve();
      const subtype = subtypeOf(dict);
      if (subtype === 'Widget' || subtype === 'Popup' || subtype === 'Redact') continue;
      const rect = rectOf(dict, transform);
      if (!rect) continue;
      const total = area(rect);
      const inside = total > 0 ? area(clip(rect, box)) / total >= 0.5 : rect[0] >= box[0] && rect[2] <= box[2] && rect[1] >= box[1] && rect[3] <= box[3];
      if (!inside) continue;
      doomedEntries.add(i);
      if (ref.isIndirect()) doomedObjects.add(ref.asIndirect());
    }
    if (!doomedEntries.size) return 0;
    for (let i = annots.length - 1; i >= 0; i--) {
      const dict = annots.get(i).resolve();
      const parent = dict.get('Parent');
      const popupOfDoomed = subtypeOf(dict) === 'Popup' && parent.isIndirect() && doomedObjects.has(parent.asIndirect());
      if (doomedEntries.has(i) || popupOfDoomed) annots.delete(i);
    }
    return doomedEntries.size;
  } finally {
    page.destroy();
  }
}

interface ImageEntry {
  ref: mupdf.PDFObject;
  jpeg: boolean;
  width: number;
  height: number;
}

function filterNames(stream: mupdf.PDFObject): string[] {
  const filter = stream.get('Filter');
  if (filter.isName()) return [filter.asName()];
  if (!filter.isArray()) return [];
  const names: string[] = [];
  for (let i = 0; i < filter.length; i++) if (filter.get(i).isName()) names.push(filter.get(i).asName());
  return names;
}

/** Every picture stream the page draws through its resources (following form XObjects), by object number. */
export function reachableImages(pdf: mupdf.PDFDocument, pageIndex: number): Map<number, ImageEntry> {
  const found = new Map<number, ImageEntry>();
  const seen = new Set<number>();
  const walk = (resources: mupdf.PDFObject, depth: number) => {
    if (!resources.isDictionary() || depth > 16) return;
    const xobjects = resources.get('XObject');
    if (!xobjects.isDictionary()) return;
    xobjects.forEach((ref) => {
      if (!ref.isIndirect() || !ref.isStream()) return;
      const num = ref.asIndirect();
      if (seen.has(num)) return;
      seen.add(num);
      const kind = subtypeOf(ref);
      if (kind === 'Image')
        found.set(num, { ref, jpeg: filterNames(ref).includes('DCTDecode'), width: ref.get('Width').asNumber(), height: ref.get('Height').asNumber() });
      else if (kind === 'Form') walk(ref.get('Resources'), depth + 1);
    });
  };
  const pageObject = pdf.findPage(pageIndex);
  try {
    walk(pageObject.getInheritable('Resources'), 0);
  } finally {
    pageObject.destroy();
  }
  return found;
}

/**
 * MuPDF blanks the cut pixels of a picture to white and stores it losslessly. This paints those pixels in the
 * paper colour instead, so a scan shows no white patch, and stores a JPEG original as JPEG again (lossless storage
 * makes a JPEG scan several times larger). Only 8-bit grey or RGB pictures without transparency; false otherwise.
 */
function repaintPicture(pdf: mupdf.PDFDocument, ref: mupdf.PDFObject, picture: ErasePlan['pictures'][number], box: Rect, jpeg: boolean): boolean {
  if (!ref.get('SMask').isNull() || !ref.get('Mask').isNull() || ref.get('BitsPerComponent').asNumber() !== 8) return false;
  const image = pdf.loadImage(ref);
  try {
    if (image.getImageMask() || image.getNumberOfComponents() > 3) return false;
    const pixmap = image.toPixmap();
    try {
      const n = pixmap.getNumberOfComponents();
      const width = pixmap.getWidth(), height = pixmap.getHeight();
      if (pixmap.getAlpha() || (n !== 1 && n !== 3) || width !== picture.width || height !== picture.height) return false;
      // The box in picture pixels (MuPDF maps the unit square, top-left first, through the transform), one pixel wider.
      const inverse = mupdf.Matrix.invert(picture.ctm);
      const corners = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => [
        (x * inverse[0] + y * inverse[2] + inverse[4]) * width,
        (x * inverse[1] + y * inverse[3] + inverse[5]) * height,
      ]);
      const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 1);
      const x1 = Math.min(width, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1);
      const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 1);
      const y1 = Math.min(height, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1);
      const [r, g, b] = picture.colour;
      const paper = n === 1 ? [Math.round(0.299 * r + 0.587 * g + 0.114 * b)] : [r, g, b];
      const pixels = pixmap.getPixels();
      const stride = pixmap.getStride();
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = y * stride + x * n;
          let white = true;
          for (let k = 0; k < n && white; k++) white = pixels[i + k] === 255;
          if (white) for (let k = 0; k < n; k++) pixels[i + k] = paper[k];
        }
      if (jpeg) {
        ref.writeRawStream(pixmap.asJPEG(JPEG_QUALITY, false));
        ref.put('Filter', pdf.newName('DCTDecode'));
      } else {
        const row = width * n;
        const packed = new Uint8Array(row * height);
        for (let y = 0; y < height; y++) packed.set(pixels.subarray(y * stride, y * stride + row), y * row);
        ref.writeStream(packed);
        ref.delete('Filter');
      }
      for (const key of ['DecodeParms', 'Decode']) ref.delete(key);
      return true;
    } finally {
      pixmap.destroy();
    }
  } finally {
    image.destroy();
  }
}

/** Repaints the pictures the removal replaced. Returns the plan's pictures that were repainted. */
function repaintReplaced(pdf: mupdf.PDFDocument, plan: ErasePlan, before: Map<number, ImageEntry>, after: Map<number, ImageEntry>): Set<number> {
  const repainted = new Set<number>();
  const replaced = [...before.entries()].filter(([num]) => !after.has(num)).map(([, entry]) => entry);
  for (const [num, entry] of after) {
    if (before.has(num)) continue;
    const index = plan.pictures.findIndex((picture, i) => !repainted.has(i) && picture.width === entry.width && picture.height === entry.height);
    if (index < 0) continue;
    const original = replaced.findIndex((old) => old.width === entry.width && old.height === entry.height);
    const jpeg = original >= 0 && replaced[original].jpeg;
    if (original >= 0) replaced.splice(original, 1);
    if (repaintPicture(pdf, entry.ref, plan.pictures[index], plan.box, jpeg)) repainted.add(index);
  }
  return repainted;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0';
}

/** Paints rectangles (page space) on top of the page, isolated from whatever drawing state the page leaves behind. */
export function paintOver(pdf: mupdf.PDFDocument, pageIndex: number, fills: { rect: Rect; colour: RGB }[]): void {
  if (!fills.length) return;
  const page = pdf.loadPage(pageIndex);
  try {
    const inverse = mupdf.Matrix.invert(page.getTransform());
    const user = (x: number, y: number) => `${fmt(x * inverse[0] + y * inverse[2] + inverse[4])} ${fmt(x * inverse[1] + y * inverse[3] + inverse[5])}`;
    let body = 'Q\nq\n';
    for (const { rect, colour } of fills) {
      const [x0, y0, x1, y1] = rect;
      body += `${colour.map((value) => fmt(value / 255)).join(' ')} rg ${user(x0, y0)} m ${user(x1, y0)} l ${user(x1, y1)} l ${user(x0, y1)} l h f\n`;
    }
    body += 'Q\n';
    const pageObject = page.getObject();
    const contents = pageObject.get('Contents');
    const array = pdf.newArray();
    array.push(pdf.addStream('q\n', {}));
    if (contents.isArray()) for (let i = 0; i < contents.length; i++) array.push(contents.get(i));
    else if (!contents.isNull()) array.push(contents);
    array.push(pdf.addStream(body, {}));
    pageObject.put('Contents', array);
  } finally {
    page.destroy();
  }
}

/**
 * Removes everything inside the box on one page: text, drawings fully inside, picture pixels (whole pictures when
 * fully inside), and stamps or comments mostly inside. Cut pictures get the paper colour from just outside the box
 * in their cleared pixels (or, when a picture cannot be repainted, a patch of that colour on top), so a scan shows
 * paper instead of a white hole. Returns false when nothing on the page changed.
 */
export function erasePage(pdf: mupdf.PDFDocument, plan: ErasePlan): { changed: boolean; removedAnnotations: number } {
  const imagesBefore = plan.pictures.length ? reachableImages(pdf, plan.pageIndex) : null;
  let page = pdf.loadPage(plan.pageIndex);
  try {
    const mark = page.createAnnotation('Redact');
    mark.setRect(plan.box);
    mark.update();
  } finally {
    page.destroy();
  }
  applyPage(pdf, plan.pageIndex, { blackBoxes: false, images: 'pixels', lineArt: 'covered', removeAnnotations: false });
  const removedAnnotations = removeAnnotationsInside(pdf, plan.pageIndex, plan.box);
  if (imagesBefore) {
    const repainted = repaintReplaced(pdf, plan, imagesBefore, reachableImages(pdf, plan.pageIndex));
    page = pdf.loadPage(plan.pageIndex);
    let remaining: Placement[];
    try {
      remaining = imagePlacements(page);
    } finally {
      page.destroy();
    }
    const fills = plan.pictures
      .filter((picture, i) => !repainted.has(i) && remaining.some((placement) => sameRect(placement.bounds, picture.bounds)))
      .map((picture) => ({ rect: clip(plan.box, picture.bounds), colour: picture.colour }));
    paintOver(pdf, plan.pageIndex, fills);
  }
  page = pdf.loadPage(plan.pageIndex);
  try {
    const after = renderRegion(page, plan.box, false).pixels;
    const changed = after.length !== plan.before.length || after.some((value, i) => value !== plan.before[i]);
    return { changed, removedAnnotations };
  } finally {
    page.destroy();
  }
}
