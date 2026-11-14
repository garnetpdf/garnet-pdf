import * as mupdf from 'mupdf';

/**
 * Undo-safe fonts and images.
 *
 * MuPDF reuses fonts and images within a document through lookup tables that journal undo, redo and
 * abandoned operations do not roll back (verified on mupdf.js 1.28.6). After an undo, addImage,
 * addFont, addSimpleFont and addCJKFont can return a reference to an object that no longer exists,
 * or whose number now belongs to another object, and the new content saves without its font or
 * picture. These helpers build each resource in a scratch document, whose tables are empty, and
 * graft it in. A per-document map reuses an earlier copy only after checking that the object still
 * exists and carries the same content key, so repeated inserts do not duplicate a font or picture.
 */
export const RESOURCE_KEY = 'GarnetKey';

const known = new WeakMap<mupdf.PDFDocument, Map<string, number>>();

function reusable(doc: mupdf.PDFDocument, key: string): mupdf.PDFObject | null {
  const num = known.get(doc)?.get(key);
  if (num === undefined || num <= 0 || num >= doc.countObjects()) return null;
  const ref = doc.newIndirect(num);
  const value = ref.resolve();
  if (value.isNull() || !(value.isDictionary() || value.isStream())) return null;
  const tag = value.get(RESOURCE_KEY);
  return tag.isString() && tag.asString() === key ? ref : null;
}

function grafted(
  doc: mupdf.PDFDocument,
  key: string,
  build: (scratch: mupdf.PDFDocument) => mupdf.PDFObject,
): mupdf.PDFObject {
  const existing = reusable(doc, key);
  if (existing) return existing;
  const scratch = new mupdf.PDFDocument();
  try {
    const ref = doc.graftObject(build(scratch));
    ref.put(RESOURCE_KEY, doc.newString(key));
    let map = known.get(doc);
    if (!map) known.set(doc, (map = new Map()));
    map.set(key, ref.asIndirect());
    return ref;
  } finally {
    scratch.destroy();
  }
}

/** Content key for resource bytes: length plus two independent 32-bit FNV-1a lanes. */
export function resourceFingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5,
    b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i] ^ (i & 0xff), 0x5bd1e995);
  }
  return `${bytes.length.toString(36)}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

/** `key` identifies the image content, normally `resourceFingerprint(bytes)` of the encoded file. */
export function addImageSafe(
  doc: mupdf.PDFDocument,
  image: mupdf.Image,
  key: string,
): mupdf.PDFObject {
  return grafted(doc, `image:${key}`, (scratch) => scratch.addImage(image));
}

/** `key` identifies the font program, e.g. `resourceFingerprint(program)` or `name:Helvetica`. */
export function addFontSafe(
  doc: mupdf.PDFDocument,
  font: mupdf.Font,
  key: string,
): mupdf.PDFObject {
  return grafted(doc, `font:${key}`, (scratch) => scratch.addFont(font));
}

export function addSimpleFontSafe(
  doc: mupdf.PDFDocument,
  font: mupdf.Font,
  encoding: 'Latin' | 'Greek' | 'Cyrillic',
  key: string,
): mupdf.PDFObject {
  return grafted(doc, `simple:${encoding}:${key}`, (scratch) =>
    scratch.addSimpleFont(font, encoding),
  );
}
