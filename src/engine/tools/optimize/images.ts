import * as mupdf from 'mupdf';
import { flattenObjects, interpretPage } from '@garnet/pdf-content';
import { downsampleSize, MIN_IMAGE_BYTES, MIN_SAVING, type ReduceSettings } from './presets';

export interface ImagePath { pageIndex: number; formPath: string[]; resName: string }
export interface ImageUsage {
  objNum: number;
  width: number;
  height: number;
  rawLength: number;
  filter: string[];
  colorSpace: string;
  bpc: number;
  hasSMask: boolean;
  isMask: boolean;
  /** Largest drawn size on any page, in points. */
  drawnWidth: number;
  drawnHeight: number;
  paths: ImagePath[];
}
export interface ImageReplacement {
  paths: ImagePath[];
  origWidth: number;
  origHeight: number;
  width: number;
  height: number;
  encoding: 'jpeg' | 'raw';
  colorSpace: 'DeviceGray' | 'DeviceRGB';
  bytes: ArrayBuffer;
  oldLength: number;
}

/** Collects every image XObject drawn on a page, keyed by object number. */
export function collectPageImages(pdf: mupdf.PDFDocument, pageIndex: number, into: Map<number, ImageUsage>) {
  const model = interpretPage(pdf, pageIndex);
  for (const object of flattenObjects(model.objects)) {
    if (object.kind !== 'image') continue;
    const [a, b, c, d] = object.ctm;
    const drawnWidth = Math.hypot(a, b), drawnHeight = Math.hypot(c, d);
    const path = { pageIndex, formPath: [...object.formPath], resName: object.resName };
    const existing = into.get(object.objNum);
    if (existing) {
      existing.drawnWidth = Math.max(existing.drawnWidth, drawnWidth);
      existing.drawnHeight = Math.max(existing.drawnHeight, drawnHeight);
      if (existing.paths.length < 64) existing.paths.push(path);
      continue;
    }
    const ref = pdf.newIndirect(object.objNum);
    let rawLength = 0;
    try { const raw = ref.readRawStream(); rawLength = raw.getLength(); raw.destroy(); } catch { rawLength = 0; }
    into.set(object.objNum, { objNum: object.objNum, width: object.width, height: object.height, rawLength, filter: object.filter, colorSpace: object.colorSpace, bpc: object.bpc, hasSMask: object.hasSMask, isMask: object.isMask, drawnWidth, drawnHeight, paths: [path] });
  }
}

const SKIP_SPACES = /Indexed|Separation|DeviceN|Lab|Pattern/;

/** Why an image is left alone, or null when it may be re-encoded. */
export function skipReason(pdf: mupdf.PDFDocument, usage: ImageUsage): string | null {
  if (usage.isMask) return 'mask';
  if (usage.bpc === 1 || usage.filter.some(f => f === 'JBIG2Decode' || f === 'CCITTFaxDecode')) return 'bilevel';
  if (usage.rawLength < MIN_IMAGE_BYTES) return 'small';
  if (SKIP_SPACES.test(usage.colorSpace)) return 'colour-space';
  const dict = pdf.newIndirect(usage.objNum);
  const imageMask = dict.get('ImageMask');
  if (!dict.get('Mask').isNull() || (imageMask.isBoolean() && imageMask.asBoolean())) return 'colour-key mask';
  const smask = dict.get('SMask');
  if (!smask.isNull() && !smask.get('Matte').isNull()) return 'matte';
  return null;
}

/**
 * Resamples the image's own colour samples. Image.toPixmap() decodes the base image without applying its soft
 * mask, so transparent edges are not blended with white; the soft mask object stays as it is.
 */
function targetPixmap(image: mupdf.Image, width: number, height: number, gray: boolean): mupdf.Pixmap {
  const base = image.toPixmap();
  try {
    const plain = new mupdf.Image(base);
    try {
      const space = gray || base.getColorSpace()?.isGray() ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
      const pixmap = new mupdf.Pixmap(space, [0, 0, width, height], false);
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      try { device.fillImage(plain, [width, 0, 0, height, 0, 0], 1); device.close(); }
      finally { device.destroy(); }
      return pixmap;
    } finally { plain.destroy(); }
  } finally { base.destroy(); }
}

/** Re-encodes one image when that saves bytes. Never returns a larger encoding. */
export function reencode(pdf: mupdf.PDFDocument, usage: ImageUsage, settings: ReduceSettings): ImageReplacement | null {
  if (skipReason(pdf, usage)) return null;
  const size = downsampleSize(usage.width, usage.height, usage.drawnWidth, usage.drawnHeight, settings);
  const isJpeg = usage.filter.includes('DCTDecode');
  const toGray = settings.grayscale && !/Gray/.test(usage.colorSpace);
  if (usage.hasSMask && !size && !toGray) return null;
  const lossy = !usage.hasSMask && (isJpeg || settings.convertLossless);
  if (!lossy && !size && !toGray) return null;
  const width = size?.width ?? usage.width, height = size?.height ?? usage.height;
  const image = pdf.loadImage(pdf.newIndirect(usage.objNum));
  let pixmap: mupdf.Pixmap | null = null;
  try {
    // CMYK images keep their colour space for print work.
    if (image.getNumberOfComponents() > 3) return null;
    pixmap = targetPixmap(image, width, height, settings.grayscale);
    const gray = pixmap.getNumberOfComponents() === 1;
    if (lossy) {
      const jpeg = pixmap.asJPEG(settings.jpegQuality, false);
      if (jpeg.byteLength > usage.rawLength * (1 - MIN_SAVING)) return null;
      return { paths: usage.paths, origWidth: usage.width, origHeight: usage.height, width, height, encoding: 'jpeg', colorSpace: gray ? 'DeviceGray' : 'DeviceRGB', bytes: Uint8Array.from(jpeg).buffer, oldLength: usage.rawLength };
    }
    const samples = pixmap.getPixels();
    const packed = new Uint8Array(width * height * pixmap.getNumberOfComponents());
    const stride = pixmap.getStride(), row = width * pixmap.getNumberOfComponents();
    for (let y = 0; y < height; y++) packed.set(samples.subarray(y * stride, y * stride + row), y * row);
    return { paths: usage.paths, origWidth: usage.width, origHeight: usage.height, width, height, encoding: 'raw', colorSpace: gray ? 'DeviceGray' : 'DeviceRGB', bytes: packed.buffer, oldLength: usage.rawLength };
  } finally {
    pixmap?.destroy();
    image.destroy();
  }
}

/** Finds the image stream an ImagePath names, following form XObject resources. */
export function resolveImage(pdf: mupdf.PDFDocument, path: ImagePath): mupdf.PDFObject | null {
  if (path.pageIndex < 0 || path.pageIndex >= pdf.countPages()) return null;
  let resources = pdf.findPage(path.pageIndex).getInheritable('Resources');
  for (const name of path.formPath) {
    const form = resources.get('XObject').get(name);
    if (!form.isStream()) return null;
    const inner = form.get('Resources');
    if (inner.isDictionary()) resources = inner;
  }
  const image = resources.get('XObject').get(path.resName);
  return image.isStream() ? image : null;
}

/** Writes a replacement into the image object found through its paths. Returns the object number. */
export function writeReplacement(pdf: mupdf.PDFDocument, replacement: ImageReplacement, done: Set<number>): number | null {
  for (const path of replacement.paths) {
    const image = resolveImage(pdf, path);
    if (!image || !image.isIndirect()) continue;
    const num = image.asIndirect();
    if (done.has(num)) return num;
    if (image.get('Width').asNumber() !== replacement.origWidth || image.get('Height').asNumber() !== replacement.origHeight) continue;
    const bytes = new Uint8Array(replacement.bytes);
    if (replacement.encoding === 'jpeg') {
      image.writeRawStream(bytes);
      image.put('Filter', pdf.newName('DCTDecode'));
    } else {
      image.writeStream(bytes);
      image.delete('Filter');
    }
    for (const key of ['DecodeParms', 'Decode', 'Alternates', 'Length1']) image.delete(key);
    image.put('Width', replacement.width);
    image.put('Height', replacement.height);
    image.put('BitsPerComponent', 8);
    image.put('ColorSpace', pdf.newName(replacement.colorSpace));
    done.add(num);
    return num;
  }
  return null;
}
