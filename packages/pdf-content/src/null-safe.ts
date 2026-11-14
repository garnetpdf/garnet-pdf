import * as mupdf from 'mupdf';

/**
 * Lookups on a missing object must give a missing object, not crash.
 *
 * mupdf.js 1.28.6 represents a missing object as the shared `PDFObject.Null`, which has no owning
 * document, so `get`, `getInheritable` and `resolve` on it throw "Cannot read properties of null
 * (reading '_fromPDFObjectKeep')". Any chained lookup then crashes on a file that lacks the first key,
 * for example `trailer.get('Root').get('AcroForm')` on a PDF with a damaged catalog (found by the corpus
 * run on a real-world file: the document could not be opened at all). In PDF terms a lookup on null is
 * null, which is also what the C library returns; this makes the JavaScript wrapper agree, once per
 * loaded copy of the library. Imported for its side effect by the package entry point, which every
 * engine realm loads.
 */
const missing = mupdf.PDFObject.Null;
const same = () => missing;
for (const method of ['get', 'getInheritable', 'resolve'] as const)
  Object.defineProperty(missing, method, { value: same, configurable: true, writable: true });

export const NULL_LOOKUPS_SAFE = true;
