import type { EngineContext } from '../context';
import { deepCopy } from '../context';
import type { PageId } from '../../shared/engine-api';
import type { OperationRequest } from '../ops/core';
import { indicesOf, pageMutation, type OutputFile, type PageOpResult } from './common';
import { saveDocument } from './assembly';
import { cropFromMargins, cropPage, detectMargins, inspectBlank, nUp, resizePage, type BlankCandidate, type Margins, type NUpOptions, type ResizeMode } from './geometry';
import type { Rect } from './pdf';

interface DocArg { docId: string }
export interface CropArgs extends DocArg {
  pageIds: PageId[];
  /** Same visual margins for every page (points, inward from the visible edge). */
  margins?: Margins;
  /** Per-page visual margins (for example from automatic detection). */
  marginsByPage?: Record<number, Margins>;
  /** Remove content outside the crop permanently (MuPDF redaction), and shrink the media box. */
  removeContent?: boolean;
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'pages.crop': { args: CropArgs; result: PageOpResult };
    'pages.detectMargins': { args: DocArg & { pageIds: PageId[]; padding?: number }; result: Record<number, Margins | null> };
    'pages.resize': { args: DocArg & { pageIds: PageId[]; size: [number, number]; mode?: ResizeMode }; result: PageOpResult };
    'pages.nup': { args: DocArg & NUpOptions & { pageIds?: PageId[]; annotations?: boolean; name?: string }; result: OutputFile };
    'pages.findBlank': { args: DocArg & { pageIds?: PageId[]; maxInk?: number }; result: (BlankCandidate & { pageId: PageId })[] };
  }
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength ? (bytes.buffer as ArrayBuffer) : Uint8Array.from(bytes).buffer;
}

export const geometryOps = {
  'pages.crop': (ctx: EngineContext, args: CropArgs) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds);
    if (!args.margins && !args.marginsByPage) throw new Error('Set the crop margins.');
    const { pdf } = ctx.get(args.docId);
    const boxes: Rect[] = indices.map((index, k) => {
      const margins = args.marginsByPage?.[args.pageIds[k]] ?? args.margins;
      if (!margins) throw new Error('Set the crop margins for every page.');
      return cropFromMargins(pdf.findPage(index), margins);
    });
    return pageMutation(ctx, args.docId, indices.length === 1 ? 'Crop page' : `Crop ${indices.length} pages`, [...args.pageIds], (doc) => {
      indices.forEach((index, k) => cropPage(doc, index, boxes[k], Boolean(args.removeContent)));
    });
  },
  'pages.detectMargins': async (ctx: EngineContext, args: DocArg & { pageIds: PageId[]; padding?: number }, request: OperationRequest) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds);
    const { pdf } = ctx.get(args.docId);
    const out: Record<number, Margins | null> = {};
    for (let k = 0; k < indices.length; k++) {
      if (request.cancelled()) throw new Error('CANCELLED');
      out[args.pageIds[k]] = detectMargins(pdf, indices[k], args.padding ?? 6);
      if (k % 10 === 9) { request.progress({ done: k + 1, total: indices.length }); await request.yield(); }
    }
    return out;
  },
  'pages.resize': (ctx: EngineContext, args: DocArg & { pageIds: PageId[]; size: [number, number]; mode?: ResizeMode }) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds);
    return pageMutation(ctx, args.docId, indices.length === 1 ? 'Resize page' : `Resize ${indices.length} pages`, [...args.pageIds], (doc) => {
      for (const index of indices) resizePage(doc, index, args.size, args.mode ?? 'fit');
    });
  },
  'pages.nup': (ctx: EngineContext, args: DocArg & NUpOptions & { pageIds?: PageId[]; annotations?: boolean; name?: string }) => {
    const { pdf } = ctx.get(args.docId);
    const indices = args.pageIds?.length ? indicesOf(ctx, args.docId, args.pageIds).sort((a, b) => a - b) : Array.from({ length: pdf.countPages() }, (_, i) => i);
    const baked = args.annotations === false ? null : deepCopy(pdf);
    try {
      if (baked) baked.bake(true, true);
      const out = nUp(baked ?? pdf, indices, args);
      try {
        return { name: `${(args.name || 'Document').replace(/\.pdf$/i, '')} - ${args.perSheet}-up.pdf`, bytes: ab(saveDocument(out)), pageCount: out.countPages() };
      } finally {
        out.destroy();
      }
    } finally {
      baked?.destroy();
    }
  },
  'pages.findBlank': async (ctx: EngineContext, args: DocArg & { pageIds?: PageId[]; maxInk?: number }, request: OperationRequest) => {
    const { pdf } = ctx.get(args.docId);
    const pages = ctx.pages(args.docId);
    const wanted = args.pageIds?.length ? new Set(args.pageIds) : null;
    const maxInk = args.maxInk ?? 0.004;
    const out: (BlankCandidate & { pageId: PageId })[] = [];
    for (const page of pages) {
      if (wanted && !wanted.has(page.id)) continue;
      if (request.cancelled()) throw new Error('CANCELLED');
      const info = inspectBlank(pdf, page.index);
      if (info.ink <= maxInk && !info.hasText && info.annotations === 0) out.push({ ...info, pageId: page.id });
      if (page.index % 10 === 9) { request.progress({ done: page.index + 1, total: pages.length }); await request.yield(); }
    }
    return out;
  },
};
