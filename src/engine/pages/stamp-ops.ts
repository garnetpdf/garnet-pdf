import * as mupdf from 'mupdf';
import type { EngineContext } from '../context';
import type { PageId } from '../../shared/engine-api';
import { indicesOf, pageMutation, type PageOpResult } from './common';
import { labelStrings, readLabelRanges } from './labels';
import { applyStamp, listStamps, removeStamps, stampFontNeeds, validateSpec, type StampInfo, type StampSpec } from './stamps';
import { FontBook, needsArabic } from './text';

interface DocArg { docId: string }
/** position and count: where the previewed page sits among the pages being stamped (for numbers). */
interface PreviewArgs { pageId: PageId; spec: StampSpec; scale: number; position?: number; count?: number; replaceId?: string }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'pages.stamp': { args: DocArg & { pageIds?: PageId[]; spec: StampSpec; replaceId?: string }; result: PageOpResult & { stampId: string } };
    'pages.removeStamps': { args: DocArg & { ids?: string[]; kind?: StampSpec['kind']; pageIds?: PageId[] }; result: PageOpResult & { removedFrom: number } };
    'pages.listStamps': { args: DocArg; result: StampInfo[] };
    'pages.stampPreview': { args: DocArg & PreviewArgs; result: { pixels: Uint8ClampedArray; width: number; height: number } };
  }
}

const LABELS: Record<StampSpec['kind'], [string, string]> = {
  'header-footer': ['Add header and footer', 'Update header and footer'],
  watermark: ['Add watermark', 'Update watermark'],
  background: ['Add background', 'Update background'],
};

function allIndices(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

async function prepareFonts(spec: StampSpec): Promise<FontBook> {
  const book = new FontBook();
  try {
    const needs = stampFontNeeds(spec);
    await book.prepare(needs.family, needsArabic(needs.text));
    return book;
  } catch (error) {
    book.close();
    throw error;
  }
}

export const stampOps = {
  'pages.stamp': async (ctx: EngineContext, args: DocArg & { pageIds?: PageId[]; spec: StampSpec; replaceId?: string }) => {
    validateSpec(args.spec);
    const { pdf } = ctx.get(args.docId);
    const indices = args.pageIds?.length ? indicesOf(ctx, args.docId, args.pageIds).sort((a, b) => a - b) : allIndices(pdf.countPages());
    const book = await prepareFonts(args.spec);
    try {
      const labels = labelStrings(readLabelRanges(pdf), pdf.countPages());
      let stampId = '';
      const label = LABELS[args.spec.kind][args.replaceId ? 1 : 0];
      const result = pageMutation(ctx, args.docId, label, 'all', (doc) => {
        if (args.replaceId) removeStamps(doc, allIndices(doc.countPages()), { ids: [args.replaceId] });
        stampId = applyStamp(doc, indices, args.spec, { labels, fonts: book });
      });
      return { ...result, stampId };
    } finally {
      book.close();
    }
  },
  'pages.removeStamps': (ctx: EngineContext, args: DocArg & { ids?: string[]; kind?: StampSpec['kind']; pageIds?: PageId[] }) => {
    const { pdf } = ctx.get(args.docId);
    const indices = args.pageIds?.length ? indicesOf(ctx, args.docId, args.pageIds) : allIndices(pdf.countPages());
    let removedFrom = 0;
    const label = args.kind === 'header-footer' ? 'Remove header and footer' : args.kind === 'watermark' ? 'Remove watermark' : args.kind === 'background' ? 'Remove background' : 'Remove page stamps';
    const result = pageMutation(ctx, args.docId, label, 'all', (doc) => {
      removedFrom = removeStamps(doc, indices, { ids: args.ids, kind: args.kind });
      if (!removedFrom) throw new Error('NOTHING_TO_REMOVE');
    });
    return { ...result, removedFrom };
  },
  'pages.listStamps': (ctx: EngineContext, args: DocArg) => listStamps(ctx.get(args.docId).pdf),
  'pages.stampPreview': async (ctx: EngineContext, args: DocArg & PreviewArgs) => {
    validateSpec(args.spec);
    const doc = ctx.get(args.docId);
    if (!(args.scale > 0 && args.scale <= 4)) throw new Error('Preview scale is out of range.');
    const index = ctx.pageIndex(args.docId, args.pageId);
    const count = Math.max(1, Math.trunc(args.count ?? 1));
    const position = Math.min(count - 1, Math.max(0, Math.trunc(args.position ?? 0)));
    const book = await prepareFonts(args.spec);
    const { pdf } = doc;
    const labels = labelStrings(readLabelRanges(pdf), pdf.countPages());
    // The preview stamps a copy of the page in a scratch document, so the open document, its
    // undo history and MuPDF's per-document font tables are never touched.
    const scratch = new mupdf.PDFDocument();
    try {
      scratch.graftPage(0, pdf, index);
      if (args.replaceId) removeStamps(scratch, [0], { ids: [args.replaceId] });
      applyStamp(scratch, [0], args.spec, { labels: [labels[index] ?? String(index + 1)], fonts: book, numbering: { position, count } }, 'preview');
      const page = scratch.loadPage(0);
      try {
        const pixmap = page.toPixmap(mupdf.Matrix.scale(args.scale, args.scale), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          const width = pixmap.getWidth(), height = pixmap.getHeight(), n = pixmap.getNumberOfComponents();
          const source = pixmap.getPixels();
          const pixels = new Uint8ClampedArray(width * height * 4);
          for (let i = 0, p = 0; i < width * height; i++, p += n) {
            pixels[4 * i] = source[p]; pixels[4 * i + 1] = source[p + 1]; pixels[4 * i + 2] = source[p + 2]; pixels[4 * i + 3] = 255;
          }
          return { pixels, width, height };
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    } finally {
      scratch.destroy();
      book.close();
    }
  },
};
