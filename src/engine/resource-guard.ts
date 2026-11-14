/**
 * Keeps fonts and pictures valid across undo.
 *
 * MuPDF reuses fonts and images within a document through lookup tables that journal undo, redo and
 * abandoned operations do not roll back (mupdf.js 1.28.6). After an undo, the next font or picture
 * MuPDF adds, including the ones its own appearance code adds for comment boxes and form fields, can
 * point at an object that no longer exists, and the change saves with its font or picture missing.
 *
 * Three layers:
 * 1. `prewarmFonts` adds the standard fonts that appearance code uses before the journal starts, so
 *    the lookup table points at objects undo can never remove (covers comment boxes and form fields
 *    in Latin, Greek and Cyrillic).
 * 2. Our own inserts use the undo-safe helpers in @garnet/pdf-content (scratch document + graft).
 * 3. `guardResources` runs inside every operation before it is committed: it checks the fonts and
 *    pictures that pages and appearance streams reference. A broken reference created in this
 *    session is repaired (standard font by its resource name, or the comment's appearance rebuilt in
 *    a scratch document); anything it cannot repair aborts the operation with a clear message, so a
 *    broken file is never produced silently.
 */
import * as mupdf from 'mupdf';
import { addSimpleFontSafe } from '@garnet/pdf-content';

const STANDARD = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
];

/** Call before `enableJournal()`. About 15 ms per document. */
export function prewarmFonts(pdf: mupdf.PDFDocument): void {
  for (const name of STANDARD) {
    const font = new mupdf.Font(name);
    try {
      for (const encoding of ['Latin', 'Greek', 'Cyrillic'] as const)
        pdf.addSimpleFont(font, encoding);
    } finally {
      font.destroy();
    }
  }
  for (const name of ['ZapfDingbats', 'Symbol']) {
    const font = new mupdf.Font(name);
    try {
      pdf.addSimpleFont(font, 'Latin');
    } finally {
      font.destroy();
    }
  }
}

/** Resource names MuPDF's appearance code gives the standard fonts (plus GRK/CYR for Greek and Cyrillic). */
const STANDARD_BY_NAME: Record<string, string> = {
  Helv: 'Helvetica',
  HeBo: 'Helvetica-Bold',
  HeOb: 'Helvetica-Oblique',
  HeBO: 'Helvetica-BoldOblique',
  HeBI: 'Helvetica-BoldOblique',
  TiRo: 'Times-Roman',
  TiBo: 'Times-Bold',
  TiIt: 'Times-Italic',
  TiBI: 'Times-BoldItalic',
  Cour: 'Courier',
  CoBo: 'Courier-Bold',
  CoOb: 'Courier-Oblique',
  CoBO: 'Courier-BoldOblique',
  CoBI: 'Courier-BoldOblique',
  ZaDb: 'ZapfDingbats',
  Symb: 'Symbol',
};

function standardFor(
  name: string,
): { font: string; encoding: 'Latin' | 'Greek' | 'Cyrillic' } | null {
  const match = /^(.*?)(GRK|CYR)?$/.exec(name);
  const font = match && STANDARD_BY_NAME[match[1]];
  if (!font) return null;
  return {
    font,
    encoding: match[2] === 'GRK' ? 'Greek' : match[2] === 'CYR' ? 'Cyrillic' : 'Latin',
  };
}

interface Broken {
  container: mupdf.PDFObject;
  name: string;
  kind: 'font' | 'xobject';
}

function nameOf(value: mupdf.PDFObject): string {
  return value.isName() ? value.asName() : '';
}

function validFont(value: mupdf.PDFObject): boolean {
  const target = value.resolve();
  return target.isDictionary() && nameOf(target.get('Type')) === 'Font';
}

function validXObject(value: mupdf.PDFObject): boolean {
  // Stream-ness belongs to the reference's xref entry: test the reference, not the resolved object.
  return value.isStream() && ['Image', 'Form', 'PS'].includes(nameOf(value.get('Subtype')));
}

/** Collects references created in this session (object number >= base) that no longer resolve correctly. */
function scanResources(
  resources: mupdf.PDFObject,
  base: number,
  seen: Set<number>,
  out: Broken[],
  depth = 0,
): void {
  if (!resources.isDictionary()) return;
  const fonts = resources.get('Font');
  if (fonts.isDictionary())
    fonts.forEach((value, name) => {
      if (value.isIndirect() && value.asIndirect() >= base && !validFont(value))
        out.push({ container: fonts, name: String(name), kind: 'font' });
    });
  const xobjects = resources.get('XObject');
  if (xobjects.isDictionary())
    xobjects.forEach((value, name) => {
      const created = value.isIndirect() && value.asIndirect() >= base;
      if (created && !validXObject(value)) {
        out.push({ container: xobjects, name: String(name), kind: 'xobject' });
        return;
      }
      // Forms made in this session may carry fonts and pictures of their own.
      if (!created || depth >= 8 || seen.has(value.asIndirect())) return;
      seen.add(value.asIndirect());
      const form = value.resolve();
      if (nameOf(form.get('Subtype')) === 'Form')
        scanResources(form.get('Resources'), base, seen, out, depth + 1);
    });
}

function appearanceStreams(annot: mupdf.PDFObject): mupdf.PDFObject[] {
  const ap = annot.get('AP');
  if (!ap.isDictionary()) return [];
  const streams: mupdf.PDFObject[] = [];
  for (const key of ['N', 'D', 'R']) {
    const entry = ap.get(key);
    if (entry.isStream()) streams.push(entry);
    else if (entry.isDictionary())
      entry.forEach((state) => {
        if (state.isStream()) streams.push(state);
      });
  }
  return streams;
}

/** Rebuilds a comment's normal appearance in a scratch document (empty font tables) and grafts it back. */
function rebuildAppearance(
  pdf: mupdf.PDFDocument,
  annotRef: mupdf.PDFObject,
  pageObj: mupdf.PDFObject,
): boolean {
  const scratch = new mupdf.PDFDocument();
  try {
    const box = pageObj.getInheritable('MediaBox');
    const rect = [0, 1, 2, 3].map((i) => box.get(i).asNumber()) as [number, number, number, number];
    scratch.insertPage(-1, scratch.addPage(rect, 0, scratch.newDictionary(), ''));
    const page = scratch.findPage(0);
    const annot = annotRef.resolve();
    const copy = scratch.newDictionary();
    annot.forEach((value, key) => {
      if (['P', 'Popup', 'IRT', 'AP', 'Parent', 'StructParent', 'OC'].includes(String(key))) return;
      copy.put(key, scratch.graftObject(value));
    });
    copy.put('P', page);
    const annots = scratch.newArray();
    annots.push(scratch.addObject(copy));
    page.put('Annots', annots);
    const loaded = scratch.loadPage(0);
    try {
      const [rebuilt] = loaded.getAnnotations();
      if (!rebuilt) return false;
      // A freshly loaded annotation is not marked dirty; setting its contents makes update() rebuild it.
      rebuilt.setContents(rebuilt.getContents());
      rebuilt.update();
      const normal = rebuilt.getObject().get('AP', 'N');
      if (!normal.isStream()) return false;
      const ap = pdf.newDictionary();
      ap.put('N', pdf.graftObject(normal));
      annot.put('AP', ap);
      return true;
    } finally {
      loaded.destroy();
    }
  } finally {
    scratch.destroy();
  }
}

export class ResourceGuardError extends Error {}

const BROKEN_MESSAGE =
  'This change was not applied because a font or picture would have gone missing after undo. ' +
  'Save the file, close it and open it again, then repeat the change.';

/**
 * Checks pages `indexes` (or every page) and the form's default resources inside the current
 * operation. `base` is the document's object count when its journal started.
 */
export function guardResources(
  pdf: mupdf.PDFDocument,
  base: number,
  indexes: number[] | 'all',
): void {
  if (pdf.countObjects() <= base) return;
  const pages = indexes === 'all' ? Array.from({ length: pdf.countPages() }, (_, i) => i) : indexes;
  const seen = new Set<number>();
  const fixFont = (broken: Broken): boolean => {
    const standard = broken.kind === 'font' ? standardFor(broken.name) : null;
    if (!standard) return false;
    const font = new mupdf.Font(standard.font);
    try {
      broken.container.put(
        broken.name,
        addSimpleFontSafe(pdf, font, standard.encoding, `name:${standard.font}`),
      );
    } finally {
      font.destroy();
    }
    return true;
  };
  for (const index of new Set(pages)) {
    if (index < 0 || index >= pdf.countPages()) continue;
    const pageObj = pdf.findPage(index);
    const pageProblems: Broken[] = [];
    scanResources(pageObj.getInheritable('Resources'), base, seen, pageProblems);
    if (pageProblems.length) throw new ResourceGuardError(BROKEN_MESSAGE);
    const annots = pageObj.get('Annots');
    if (!annots.isArray()) continue;
    for (let i = 0; i < annots.length; i++) {
      const annotRef = annots.get(i);
      const annot = annotRef.resolve();
      if (!annot.isDictionary()) continue;
      const problems: Broken[] = [];
      for (const stream of appearanceStreams(annot))
        scanResources(stream.get('Resources'), base, seen, problems);
      if (!problems.length) continue;
      const remaining = problems.filter((broken) => !fixFont(broken));
      if (!remaining.length) continue;
      const widget = nameOf(annot.get('Subtype')) === 'Widget';
      if (widget || !rebuildAppearance(pdf, annotRef, pageObj))
        throw new ResourceGuardError(BROKEN_MESSAGE);
      const again: Broken[] = [];
      for (const stream of appearanceStreams(annot))
        scanResources(stream.get('Resources'), base, new Set(), again);
      if (again.length) throw new ResourceGuardError(BROKEN_MESSAGE);
    }
  }
  const dr = pdf.getTrailer().get('Root', 'AcroForm', 'DR');
  if (dr.isDictionary()) {
    const problems: Broken[] = [];
    scanResources(dr, base, seen, problems);
    if (problems.filter((broken) => !fixFont(broken)).length)
      throw new ResourceGuardError(BROKEN_MESSAGE);
  }
}
