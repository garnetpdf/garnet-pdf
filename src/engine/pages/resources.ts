/**
 * Fonts and images added by page operations.
 *
 * MuPDF reuses fonts and images within a document through lookup tables that undo and abandoned
 * operations do not roll back. After an undo, addFont, addSimpleFont and addImage can return a
 * reference to an object that no longer exists, and the new header, watermark or page silently
 * loses its font or picture. New objects are therefore built in a scratch document and grafted in;
 * fonts are tagged so that a later operation can reuse one that a live stamp still uses.
 */
import * as mupdf from 'mupdf';
import type { Doc, Obj } from './pdf';

/** Key in the font dictionary identifying which font file and version it holds. */
export const FONT_TAG = 'GarnetFont';

function grafted(pdf: Doc, build: (scratch: mupdf.PDFDocument) => Obj): Obj {
  const scratch = new mupdf.PDFDocument();
  try {
    return pdf.graftObject(build(scratch));
  } finally {
    scratch.destroy();
  }
}

export function freshFont(pdf: Doc, font: mupdf.Font, kind: 'simple' | 'cid', tag: string): Obj {
  const ref = grafted(pdf, (scratch) => (kind === 'simple' ? scratch.addSimpleFont(font, 'Latin') : scratch.addFont(font)));
  ref.put(FONT_TAG, pdf.newString(tag));
  return ref;
}

export function freshImage(pdf: Doc, image: mupdf.Image): Obj {
  return grafted(pdf, (scratch) => scratch.addImage(image));
}

/** Short stable fingerprint of font bytes (FNV-1a), so a tag changes when the font file does. */
export function fingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
