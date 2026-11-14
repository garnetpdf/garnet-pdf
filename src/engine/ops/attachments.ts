import type * as mupdf from 'mupdf';
import type { EngineContext } from '../context';
import type { OpResult } from '../../shared/engine-api';

export interface AttachmentInfo {
  id: string;
  name: string;
  description: string;
  size: number;
  modified: string | null;
  /** Document-level attachment, or a file attached to a comment on a page. */
  pageIndex: number | null;
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'attachments.list': { args: { docId: string }; result: AttachmentInfo[] };
    'attachments.add': { args: { docId: string; name: string; bytes: ArrayBuffer; mime?: string }; result: OpResult & { name: string } };
    'attachments.read': { args: { docId: string; id: string }; result: { name: string; bytes: ArrayBuffer } };
    'attachments.remove': { args: { docId: string; id: string }; result: OpResult };
  }
}

const MAX_ATTACHMENT = 512 * 1024 * 1024;

function fileName(spec: mupdf.PDFObject, fallback: string): string {
  for (const key of ['UF', 'F', 'DOS', 'Unix', 'Mac']) {
    const value = spec.get(key);
    if (value.isString() && value.asString()) return value.asString();
  }
  return fallback;
}

function embeddedStream(spec: mupdf.PDFObject): mupdf.PDFObject | null {
  const ef = spec.get('EF');
  for (const key of ['UF', 'F']) if (ef.get(key).isStream()) return ef.get(key);
  return null;
}

function describe(pdf: mupdf.PDFDocument, spec: mupdf.PDFObject, id: string, fallback: string, pageIndex: number | null): AttachmentInfo {
  const stream = embeddedStream(spec);
  let size = 0;
  let modified: string | null = null;
  if (stream) {
    const params = stream.get('Params');
    const declared = params.get('Size');
    if (declared.isNumber()) size = declared.asNumber();
    else {
      const contents = pdf.getEmbeddedFileContents(spec);
      size = contents ? contents.getLength() : 0;
      contents?.destroy();
    }
    const date = params.get('ModDate');
    if (date.isString()) modified = date.asString();
  }
  const description = spec.get('Desc');
  return { id, name: fileName(spec, fallback), description: description.isString() ? description.asString() : '', size, modified, pageIndex };
}

/** "D:YYYYMMDDHHmmSSZ" for a date in UTC. */
function pdfDate(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

/**
 * Builds an embedded file stream and its file specification. MuPDF 1.28.6's addEmbeddedFile leaves a journal
 * operation open (getJournal then fails with "Can't undo/redo during an operation"), so the objects are written here.
 */
function fileSpec(pdf: mupdf.PDFDocument, name: string, mime: string | undefined, bytes: Uint8Array): mupdf.PDFObject {
  const now = pdfDate(new Date());
  const params = pdf.newDictionary();
  params.put('Size', bytes.byteLength);
  params.put('CreationDate', pdf.newString(now));
  params.put('ModDate', pdf.newString(now));
  const streamDict = pdf.newDictionary();
  streamDict.put('Type', pdf.newName('EmbeddedFile'));
  if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) streamDict.put('Subtype', pdf.newName(mime));
  streamDict.put('Params', params);
  const stream = pdf.addStream(bytes, streamDict);
  const ef = pdf.newDictionary();
  ef.put('F', stream);
  ef.put('UF', stream);
  const spec = pdf.newDictionary();
  spec.put('Type', pdf.newName('Filespec'));
  spec.put('F', pdf.newString(name));
  spec.put('UF', pdf.newString(name));
  spec.put('EF', ef);
  return pdf.addObject(spec);
}

function pageAttachments(pdf: mupdf.PDFDocument, visit: (pageIndex: number, annot: mupdf.PDFObject, spec: mupdf.PDFObject) => void) {
  for (let i = 0; i < pdf.countPages(); i++) {
    const annots = pdf.findPage(i).get('Annots');
    if (!annots.isArray()) continue;
    for (let j = 0; j < annots.length; j++) {
      const annot = annots.get(j);
      const dict = annot.resolve();
      if (dict.get('Subtype').isName() && dict.get('Subtype').asName() === 'FileAttachment' && dict.get('FS').isDictionary()) visit(i, annot, dict.get('FS'));
    }
  }
}

export const namespace = 'attachments';
export const ops = {
  'attachments.list': (ctx: EngineContext, args: { docId: string }) => {
    const { pdf } = ctx.get(args.docId);
    const list: AttachmentInfo[] = [];
    for (const [name, spec] of Object.entries(pdf.getEmbeddedFiles())) list.push(describe(pdf, spec, `doc:${name}`, name, null));
    pageAttachments(pdf, (pageIndex, annot, spec) => {
      if (annot.isIndirect()) list.push(describe(pdf, spec, `annot:${annot.asIndirect()}`, 'Attachment', pageIndex));
    });
    return list;
  },
  'attachments.add': (ctx: EngineContext, args: { docId: string; name: string; bytes: ArrayBuffer; mime?: string }) => {
    if (args.bytes.byteLength > MAX_ATTACHMENT) throw new Error('Attachments are limited to 512 MB.');
    const { pdf } = ctx.get(args.docId);
    const existing = new Set(Object.keys(pdf.getEmbeddedFiles()));
    const clean = args.name.replace(/[\\/\p{Cc}]+/gu, ' ').trim().slice(0, 200) || 'Attachment';
    let name = clean;
    for (let i = 2; existing.has(name); i++) name = clean.replace(/(\.[^.]*)?$/, ext => ` (${i})${ext}`);
    const result = ctx.mutate(args.docId, `Attach ${name}`, [], live => live.insertEmbeddedFile(name, fileSpec(live, name, args.mime, new Uint8Array(args.bytes))));
    return { ...result, name };
  },
  'attachments.read': (ctx: EngineContext, args: { docId: string; id: string }) => {
    const { pdf } = ctx.get(args.docId);
    let spec: mupdf.PDFObject | null = null;
    let name = 'Attachment';
    if (args.id.startsWith('doc:')) {
      name = args.id.slice(4);
      spec = pdf.getEmbeddedFiles()[name] ?? null;
    } else if (args.id.startsWith('annot:')) {
      const num = Number(args.id.slice(6));
      pageAttachments(pdf, (_page, annot, fs) => { if (annot.isIndirect() && annot.asIndirect() === num) spec = fs; });
    }
    if (!spec) throw new Error('This attachment is no longer in the document.');
    const contents = pdf.getEmbeddedFileContents(spec);
    if (!contents) throw new Error('This attachment has no file data.');
    try { return { name: fileName(spec, name), bytes: Uint8Array.from(contents.asUint8Array()).buffer }; }
    finally { contents.destroy(); }
  },
  'attachments.remove': (ctx: EngineContext, args: { docId: string; id: string }) => {
    const { pdf } = ctx.get(args.docId);
    if (args.id.startsWith('doc:')) {
      const name = args.id.slice(4);
      if (!pdf.getEmbeddedFiles()[name]) throw new Error('This attachment is no longer in the document.');
      return ctx.mutate(args.docId, `Delete attachment ${name}`, [], live => live.deleteEmbeddedFile(name));
    }
    const num = Number(args.id.slice(6));
    let pageIndex = -1;
    pageAttachments(pdf, (page, annot) => { if (annot.isIndirect() && annot.asIndirect() === num) pageIndex = page; });
    if (pageIndex < 0) throw new Error('This attachment is no longer in the document.');
    const pageId = ctx.pageInfo(args.docId, pageIndex).id;
    return ctx.mutate(args.docId, 'Delete attached file', [pageId], live => {
      const annots = live.findPage(pageIndex).get('Annots');
      for (let i = annots.length - 1; i >= 0; i--) {
        const item = annots.get(i);
        if (!item.isIndirect()) continue;
        const parent = item.resolve().get('Parent');
        if (item.asIndirect() === num || (parent.isIndirect() && parent.asIndirect() === num)) annots.delete(i);
      }
    });
  },
};
