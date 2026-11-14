import * as mupdf from 'mupdf';
import { deepCopy, type EngineContext } from '../context';
import type { DocumentInfo, LinkInfo, OpResult, OutlineItem, PageId, PageInfo, Quad, Rect, SearchHit, TextLine } from '../../shared/engine-api';

interface DocArg { docId: string }
interface PageArg extends DocArg { pageId: PageId }
export interface RenderArgs extends PageArg {
  scale: number;
  dpr?: number;
  rect?: Rect;
  annots?: boolean;
  forms?: boolean;
  /** Bypass the worker's bitmap cache for independent timing samples. */
  cache?: boolean;
}
export interface RenderResult {
  bitmap?: ImageBitmap;
  pixels?: Uint8ClampedArray;
  width: number;
  height: number;
  elapsedMs: number;
}
type EncryptionDecision =
  | { mode: 'remove' }
  | { mode: 'keep'; userPassword?: string; ownerPassword?: string }
  | { mode: 'set'; userPassword: string; ownerPassword: string; permissions?: number };

declare module '../../shared/engine-api' {
  interface EngineOps {
    'core.open': { args: { bytes: ArrayBuffer; password?: string; docId?: string; mime?: 'application/pdf' | 'image/png' | 'image/jpeg'; unsaved?: boolean }; result: DocumentInfo };
    'core.close': { args: DocArg; result: void };
    'core.render': { args: RenderArgs; result: RenderResult };
    'core.text': { args: PageArg; result: { text: string; lines: TextLine[] } };
    'core.search': { args: DocArg & { query: string; caseSensitive?: boolean; wholeWord?: boolean }; result: SearchHit[] };
    'core.undo': { args: DocArg; result: OpResult };
    'core.redo': { args: DocArg; result: OpResult };
    'core.history': { args: DocArg; result: OpResult };
    'core.gotoHistory': { args: DocArg & { position: number }; result: OpResult };
    'core.save': { args: DocArg & { options?: string; encryption?: EncryptionDecision }; result: { bytes: ArrayBuffer; pageCount: number; revision: number; hasSignatures: boolean } };
    'core.snapshot': { args: DocArg; result: { bytes: ArrayBuffer; pageCount: number; revision: number } };
    'core.pageInfo': { args: DocArg; result: PageInfo[] };
    'core.getOutline': { args: DocArg; result: OutlineItem[] };
    'core.getLinks': { args: PageArg; result: LinkInfo[] };
    'core.markSaved': { args: DocArg & { revision?: number; encryption?: EncryptionDecision }; result: OpResult };
    'core.memory': { args: DocArg; result: { wasmHeapBytes: number | null; jsHeapBytes: number | null; journalSteps: number } };
    'core.clearHistory': { args: DocArg; result: OpResult };
    'core.beginTransaction': { args: DocArg & { label: string }; result: void };
    'core.endTransaction': { args: DocArg; result: OpResult };
    'core.abortTransaction': { args: DocArg; result: OpResult };
  }
}

export interface OperationRequest {
  cancelled: () => boolean;
  progress: (data: unknown) => void;
  yield: () => Promise<void>;
}
export type Handler = (ctx: EngineContext, args: never, request: OperationRequest) => unknown | Promise<unknown>;

function getOutline(pdf: mupdf.PDFDocument): OutlineItem[] {
  function map(items: ReturnType<mupdf.PDFDocument['loadOutline']>): OutlineItem[] {
    return (items || []).map(item => ({
      title: item.title || '', page: item.page, uri: item.uri,
      children: item.down ? map(item.down) : undefined,
    }));
  }
  return map(pdf.loadOutline());
}

/** One error for every way a broken file fails to open; the app shows it as "damaged", with the detail kept. */
function damagedFile(error: unknown): Error {
  const detail = String((error as Error)?.message ?? error);
  return detail.startsWith('DAMAGED_FILE') ? (error as Error) : new Error(`DAMAGED_FILE: ${detail.slice(0, 200)}`);
}

function hasSignatures(pdf: mupdf.PDFDocument): boolean {
  const catalog = pdf.getTrailer().get('Root');
  const acroForm = catalog.get('AcroForm');
  if (acroForm.isNull()) return false;
  const fields = acroForm.get('Fields');
  if (!fields.isArray()) return false;
  const inspect = (field: mupdf.PDFObject): boolean => {
    const resolved = field.resolve();
    const type = resolved.get('FT');
    if (!type.isNull() && type.asName() === 'Sig' && !resolved.get('V').isNull()) return true;
    const kids = resolved.get('Kids');
    if (kids.isArray()) {
      for (let i = 0; i < kids.length; i++) if (inspect(kids.get(i))) return true;
    }
    return false;
  };
  for (let i = 0; i < fields.length; i++) if (inspect(fields.get(i))) return true;
  return false;
}

function copiedBytes(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function isEncrypted(pdf: mupdf.PDFDocument) {
  const value = pdf.getMetaData('encryption');
  return Boolean(value && value !== 'None');
}

function openImage(bytes: ArrayBuffer): mupdf.PDFDocument {
  const image = new mupdf.Image(bytes);
  const pdf = new mupdf.PDFDocument();
  try {
    const width = image.getWidth() * 72 / (image.getXResolution() || 72);
    const height = image.getHeight() * 72 / (image.getYResolution() || 72);
    const reference = pdf.addImage(image);
    const xObject = pdf.newDictionary();
    xObject.put('Image0', reference);
    const resources = pdf.newDictionary();
    resources.put('XObject', xObject);
    const page = pdf.addPage([0, 0, width, height], 0, resources, `q ${width} 0 0 ${height} 0 0 cm /Image0 Do Q`);
    pdf.insertPage(0, page);
    return pdf;
  } catch (error) { pdf.destroy(); throw error; }
  finally { image.destroy(); }
}

function saveBytes(ctx: EngineContext, args: DocArg & { options?: string; encryption?: EncryptionDecision }, recovery = false) {
  const doc = ctx.get(args.docId);
  const signatures = hasSignatures(doc.pdf);
  const encrypted = doc.encryptedOriginal;
  if (encrypted && !args.encryption && !recovery && (doc.knownUserPassword === undefined || doc.knownOwnerPassword === undefined)) throw new Error('ENCRYPTION_DECISION_REQUIRED');
  const encryption = args.encryption ?? (encrypted && !recovery ? { mode: 'keep' as const } : undefined);
  const options: Record<string, string | number | boolean> = {};
  for (const entry of (args.options ?? 'garbage=compact,compress,objstms').split(',')) {
    const [name, value] = entry.split('=', 2);
    if (name) options[name] = value ?? true;
  }
  if ('encrypt' in options || 'user-password' in options || 'owner-password' in options) {
    throw new Error('Specify PDF encryption through the encryption decision.');
  }
  if (encryption && encryption.mode !== 'remove') {
    let method: string, permissions: number | null;
    let userPassword: string | undefined, ownerPassword: string | undefined;
    if (encryption.mode === 'keep') {
      if (!doc.encryptedOriginal) throw new Error('This document has no encryption to keep.');
      method = doc.originalEncryptionMethod || '';
      if (!method) throw new Error('The original encryption method is unsupported. Choose new protection or remove it.');
      permissions = doc.originalPermissions;
      userPassword = encryption.userPassword ?? doc.knownUserPassword;
      ownerPassword = encryption.ownerPassword ?? doc.knownOwnerPassword;
      if (userPassword === undefined) throw new Error('USER_PASSWORD_REQUIRED');
      if (ownerPassword === undefined) throw new Error('OWNER_PASSWORD_REQUIRED');
      if (doc.protectionMatchesLive) {
        try {
          if (!doc.pdf.authenticatePassword(userPassword)) throw new Error('USER_PASSWORD_INCORRECT');
          if (!(doc.pdf.authenticatePassword(ownerPassword) & 4)) throw new Error('OWNER_PASSWORD_INCORRECT');
        } finally {
          if (doc.openingPassword !== undefined) doc.pdf.authenticatePassword(doc.openingPassword);
        }
      } else {
        if (userPassword !== doc.knownUserPassword) throw new Error('USER_PASSWORD_INCORRECT');
        if (ownerPassword !== doc.knownOwnerPassword) throw new Error('OWNER_PASSWORD_INCORRECT');
      }
    } else {
      method = 'aes-256';
      permissions = encryption.permissions ?? doc.originalPermissions ?? -4;
      userPassword = encryption.userPassword;
      ownerPassword = encryption.ownerPassword;
    }
    for (const password of [userPassword, ownerPassword]) {
      if ([...password].some(character => {
        const code = character.codePointAt(0) || 0;
        return code < 32 || code === 127;
      })) throw new Error('Passwords cannot contain line breaks or control characters.');
    }
    options.encrypt = method;
    options['user-password'] = userPassword;
    options['owner-password'] = ownerPassword;
    if (permissions !== null) options.permissions = permissions;
  }
  const copy = deepCopy(doc.pdf);
  let retry: mupdf.PDFDocument | undefined;
  try {
    let buffer: mupdf.Buffer;
    try {
      buffer = copy.saveToBuffer(options);
    } catch (error) {
      // MuPDF 1.28.6 cannot write a stream that lists more filters than decode parameters when the first
      // filter is ASCIIHex or ASCII85 ("index out of bounds"), and it has already altered the copy by then.
      // Start again from a second fresh copy with those lists made equally long; any other failure is passed on.
      if (!/index out of bounds/.test(String((error as Error)?.message ?? error))) throw error;
      retry = deepCopy(doc.pdf);
      if (!padDecodeParms(retry)) throw error;
      buffer = retry.saveToBuffer(options);
    }
    try { return { bytes: copiedBytes(buffer.asUint8Array()), pageCount: doc.pdf.countPages(), revision: doc.revision, hasSignatures: signatures }; }
    finally { buffer.destroy(); }
  } finally {
    copy.destroy();
    retry?.destroy();
  }
}

/** Makes every stream's DecodeParms list as long as its Filter list (missing entries are null). Returns the number changed. */
function padDecodeParms(pdf: mupdf.PDFDocument): number {
  let changed = 0;
  const total = pdf.countObjects();
  for (let number = 1; number < total; number++) {
    const ref = pdf.newIndirect(number);
    if (!ref.isStream()) continue;
    const dict = ref.resolve(), filters = dict.get('Filter'), parms = dict.get('DecodeParms');
    if (!parms.isArray()) continue;
    if (filters.isArray() && parms.length < filters.length) {
      while (parms.length < filters.length) parms.push(pdf.newNull());
      changed++;
    } else if (!filters.isArray() && parms.length === 0) {
      dict.delete('DecodeParms');
      changed++;
    }
  }
  return changed;
}

const methods = {
  'core.open': (ctx: EngineContext, args: { bytes: ArrayBuffer; password?: string; docId?: string; mime?: 'application/pdf' | 'image/png' | 'image/jpeg'; unsaved?: boolean }): DocumentInfo => {
    const head = new Uint8Array(args.bytes, 0, Math.min(8, args.bytes.byteLength));
    const pdfMagic = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    const pngMagic = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const jpegMagic = head[0] === 0xff && head[1] === 0xd8;
    const image = args.mime?.startsWith('image/') || (!pdfMagic && (pngMagic || jpegMagic));
    let pdf: mupdf.PDFDocument | null;
    try {
      pdf = image ? openImage(args.bytes) : mupdf.Document.openDocument(args.bytes, 'application/pdf').asPDF();
    } catch (error) {
      throw damagedFile(error);
    }
    if (!pdf) throw new Error('This file is not a PDF.');
    let openingPasswordRole: 'user' | 'owner' | undefined;
    if (pdf.needsPassword()) {
      if (args.password === undefined) { pdf.destroy(); throw new Error('PASSWORD_REQUIRED'); }
      const authenticated = pdf.authenticatePassword(args.password);
      if (!authenticated) { pdf.destroy(); throw new Error('PASSWORD_INCORRECT'); }
      openingPasswordRole = authenticated & 4 ? 'owner' : 'user';
    }
    const repaired = pdf.wasRepaired();
    // A damaged file can open with no pages, or fail only when its page tree is read: refuse it cleanly here.
    let pageTotal = 0;
    try {
      pageTotal = pdf.countPages();
    } catch (error) {
      pdf.destroy();
      throw damagedFile(error);
    }
    if (pageTotal < 1) {
      pdf.destroy();
      throw damagedFile('it has no readable pages');
    }
    // A page whose own record cannot be read (a syntax error in the file) is still counted by the page list.
    // Shown as a blank page it made every saved copy invalid, so it is left out here, before undo history
    // starts, and the document is flagged as repaired with a plain note.
    const unreadablePages: number[] = [];
    try {
      for (let i = 0; i < pageTotal; i++) if (!pdf.findPage(i).isDictionary()) unreadablePages.push(i);
      if (unreadablePages.length === pageTotal) throw new Error('it has no readable pages');
      for (const i of [...unreadablePages].reverse()) pdf.deletePage(i);
    } catch (error) {
      pdf.destroy();
      throw damagedFile(error);
    }
    // From here the engine owns the document: any failure must release it and report the file as damaged.
    let docId: string | undefined;
    try {
      docId = ctx.add(pdf, args.docId, Boolean(args.unsaved || image), openingPasswordRole ? args.password : undefined, openingPasswordRole);
      const openDocument = ctx.get(docId);
      const metadata: Record<string, string> = {};
      for (const key of ['format', 'encryption', 'info:Title', 'info:Author', 'info:Subject', 'info:Keywords', 'info:Creator', 'info:Producer']) {
        const value = pdf.getMetaData(key);
        if (value) metadata[key] = value;
      }
      const permissions: Record<string, boolean> = {};
      for (const key of ['print', 'copy', 'edit', 'annotate', 'form', 'accessibility', 'assemble', 'print-hq'] as mupdf.DocumentPermission[]) permissions[key] = pdf.hasPermission(key);
      // Bookmarks and signature fields are extras: a damaged one must not stop the document from opening.
      const notices: string[] = [];
      if (unreadablePages.length)
        notices.push(
          unreadablePages.length === 1
            ? `Page ${unreadablePages[0] + 1} is damaged in the file and could not be read. It is left out.`
            : `${unreadablePages.length} pages are damaged in the file and could not be read (pages ${unreadablePages.slice(0, 8).map(i => i + 1).join(', ')}${unreadablePages.length > 8 ? ' and more' : ''}). They are left out.`,
        );
      const optional = <T,>(label: string, read: () => T, fallback: T): T => {
        try {
          return read();
        } catch {
          notices.push(`${label}.`);
          return fallback;
        }
      };
      const pages = ctx.pages(docId);
      // Read before the result is built, so a note from either reaches it.
      const outline = optional('Bookmarks could not be read', () => getOutline(pdf), []);
      const signed = optional('Signature fields could not be read', () => hasSignatures(pdf), false);
      return {
        docId, pageCount: pages.length, pages, outline, metadata, permissions, repaired: repaired || unreadablePages.length > 0,
        ...(notices.length ? { notices } : {}),
        encrypted: isEncrypted(pdf), encryptionMethod: openDocument.originalEncryptionMethod, encryptionPermissions: openDocument.originalPermissions,
        hasSignatures: signed, dirty: ctx.dirty(docId), revision: 0,
      };
    } catch (error) {
      if (docId !== undefined) ctx.documents.delete(docId);
      try {
        pdf.destroy();
      } catch {
        /* already released */
      }
      const text = String((error as Error)?.message ?? error);
      if (text === 'Document ID already exists.') throw error;
      throw damagedFile(error);
    }
  },
  'core.close': (ctx: EngineContext, args: DocArg) => {
    const doc = ctx.get(args.docId);
    ctx.documents.delete(args.docId);
    doc.pdf.destroy();
  },
  'core.render': (ctx: EngineContext, args: RenderArgs): RenderResult => {
    const started = performance.now();
    const page = ctx.get(args.docId).pdf.loadPage(ctx.pageIndex(args.docId, args.pageId));
    const factor = args.scale * (args.dpr || 1);
    if (!(factor > 0) || !Number.isFinite(factor) || factor > 64) throw new Error('Zoom is out of range.');
    const matrix = mupdf.Matrix.scale(factor, factor);
    let pixmap: mupdf.Pixmap;
    if (args.rect) {
      const [x0, y0, x1, y1] = args.rect;
      const bounds: Rect = [Math.floor(x0 * factor), Math.floor(y0 * factor), Math.ceil(x1 * factor), Math.ceil(y1 * factor)];
      pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bounds, false);
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      page.runPageContents(device, matrix);
      if (args.annots !== false) page.runPageAnnots(device, matrix);
      if (args.forms !== false) page.runPageWidgets(device, matrix);
      device.close();
    } else if (args.annots === false || args.forms === false) {
      const bounds = mupdf.Rect.transform(page.getBounds(), matrix);
      pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bounds, false);
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      page.runPageContents(device, matrix);
      if (args.annots !== false) page.runPageAnnots(device, matrix);
      if (args.forms !== false) page.runPageWidgets(device, matrix);
      device.close();
    } else {
      pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    }
    const width = pixmap.getWidth(), height = pixmap.getHeight();
    const source = pixmap.getPixels();
    const pixels = new Uint8ClampedArray(width * height * 4);
    const n = pixmap.getNumberOfComponents();
    for (let i = 0, p = 0; i < width * height; i++, p += n) {
      pixels[4 * i] = source[p]; pixels[4 * i + 1] = source[p + 1]; pixels[4 * i + 2] = source[p + 2]; pixels[4 * i + 3] = 255;
    }
    pixmap.destroy(); page.destroy();
    return { pixels, width, height, elapsedMs: performance.now() - started };
  },
  'core.text': (ctx: EngineContext, args: PageArg) => {
    const page = ctx.get(args.docId).pdf.loadPage(ctx.pageIndex(args.docId, args.pageId));
    const stext = page.toStructuredText('preserve-whitespace');
    const lines: TextLine[] = [];
    let line: TextLine | undefined;
    stext.walk({
      beginLine(bbox, _wmode, direction) { line = { text: '', bbox, direction, chars: [] }; },
      onChar(c, origin, font, size, quad, _color, bidi) {
        if (!line) return;
        line.text += c;
        line.chars.push({ c, origin, quad, font: font.getName(), size, bidi });
      },
      endLine() { if (line) lines.push(line); line = undefined; },
    });
    const text = stext.asText();
    stext.destroy(); page.destroy();
    return { text, lines };
  },
  'core.search': async (ctx: EngineContext, args: DocArg & { query: string; caseSensitive?: boolean; wholeWord?: boolean }, request: OperationRequest): Promise<SearchHit[]> => {
    if (!args.query) return [];
    const { pdf } = ctx.get(args.docId);
    const hits: SearchHit[] = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      if (request.cancelled()) throw new Error('CANCELLED');
      const page = pdf.loadPage(i);
      let quads: Quad[][];
      if (args.caseSensitive || args.wholeWord) {
        quads = [];
        const st = page.toStructuredText('preserve-whitespace');
        let lineText = '';
        let chars: { start: number; end: number; quad: Quad }[] = [];
        const finishLine = () => {
          const haystack = args.caseSensitive ? lineText : lineText.toLocaleLowerCase();
          const needle = args.caseSensitive ? args.query : args.query.toLocaleLowerCase();
          const word = /[\p{L}\p{N}_]/u;
          let from = 0;
          while (true) {
            const at = haystack.indexOf(needle, from);
            if (at < 0) break;
            const end = at + needle.length;
            if (!args.wholeWord || (!word.test(lineText[at - 1] ?? '') && !word.test(lineText[end] ?? ''))) {
              const match = chars.filter(char => char.end > at && char.start < end).map(char => char.quad);
              if (match.length) quads.push(match);
            }
            from = at + Math.max(needle.length, 1);
          }
        };
        st.walk({
          beginLine() { lineText = ''; chars = []; },
          onChar(c, _origin, _font, _size, quad) {
            const start = lineText.length;
            lineText += c;
            chars.push({ start, end: lineText.length, quad });
          },
          endLine() { finishLine(); },
        });
        st.destroy();
      } else quads = page.search(args.query, {});
      for (const match of quads) {
        const hit = { pageId: ctx.pageInfo(args.docId, i).id, pageIndex: i, quads: match };
        hits.push(hit); request.progress({ type: 'searchHit', hit });
      }
      request.progress({ type: 'searchProgress', page: i + 1, pages: pdf.countPages() });
      page.destroy();
      await request.yield();
    }
    return hits;
  },
  'core.undo': (ctx: EngineContext, args: DocArg) => {
    const doc = ctx.get(args.docId);
    if (!doc.pdf.canUndo()) return ctx.result(args.docId, []);
    doc.pdf.undo();
    return ctx.travelled(args.docId);
  },
  'core.redo': (ctx: EngineContext, args: DocArg) => {
    const doc = ctx.get(args.docId);
    if (!doc.pdf.canRedo()) return ctx.result(args.docId, []);
    doc.pdf.redo();
    return ctx.travelled(args.docId);
  },
  'core.history': (ctx: EngineContext, args: DocArg) => ctx.result(args.docId, []),
  'core.gotoHistory': (ctx: EngineContext, args: DocArg & { position: number }) => {
    const doc = ctx.get(args.docId);
    const journal = doc.pdf.getJournal();
    if (!Number.isInteger(args.position) || args.position < 0 || args.position > journal.steps.length) throw new Error('History position is out of range.');
    while (doc.pdf.getJournal().position > args.position) doc.pdf.undo();
    while (doc.pdf.getJournal().position < args.position) doc.pdf.redo();
    return ctx.travelled(args.docId);
  },
  'core.save': (ctx: EngineContext, args: DocArg & { options?: string; encryption?: EncryptionDecision }) => saveBytes(ctx, args),
  'core.snapshot': (ctx: EngineContext, args: DocArg) => {
    const result = saveBytes(ctx, args, true);
    return { bytes: result.bytes, pageCount: result.pageCount, revision: result.revision };
  },
  'core.pageInfo': (ctx: EngineContext, args: DocArg) => ctx.pages(args.docId),
  'core.getOutline': (ctx: EngineContext, args: DocArg) => getOutline(ctx.get(args.docId).pdf),
  'core.getLinks': (ctx: EngineContext, args: PageArg): LinkInfo[] => {
    const page = ctx.get(args.docId).pdf.loadPage(ctx.pageIndex(args.docId, args.pageId));
    const links = page.getLinks().map(link => {
      const value = { bounds: link.getBounds(), uri: link.getURI(), external: link.isExternal() };
      link.destroy(); return value;
    });
    page.destroy();
    return links;
  },
  'core.markSaved': (ctx: EngineContext, args: DocArg & { revision?: number; encryption?: EncryptionDecision }) => ctx.markSaved(args.docId, args.revision, args.encryption),
  'core.memory': (ctx: EngineContext, args: DocArg) => {
    const module = globalThis.$libmupdf_wasm_Module as { HEAPU8?: Uint8Array } | undefined;
    const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    return {
      wasmHeapBytes: module?.HEAPU8?.byteLength ?? null,
      jsHeapBytes: memory.memory?.usedJSHeapSize ?? null,
      journalSteps: ctx.get(args.docId).pdf.getJournal().steps.length,
    };
  },
  'core.clearHistory': (ctx: EngineContext, args: DocArg) => ctx.clearHistory(args.docId),
  'core.beginTransaction': (ctx: EngineContext, args: DocArg & { label: string }) => ctx.beginTransaction(args.docId, args.label),
  'core.endTransaction': (ctx: EngineContext, args: DocArg) => ctx.endTransaction(args.docId),
  'core.abortTransaction': (ctx: EngineContext, args: DocArg) => ctx.abortTransaction(args.docId),
} satisfies Record<string, Handler>;

export const namespace = 'core';
export const ops = methods;
