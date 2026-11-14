import type { EngineContext } from '../context';
import type { PageId } from '../../shared/engine-api';
import { indicesOf, pageMutation, sourcePages, type OutputFile, type PageBoxInfo, type PageOpResult, type PageSource } from '../pages/common';
export type { OutputFile, PageBoxInfo, PageOpResult, PageSource } from '../pages/common';
import type { OperationRequest } from './core';
import { appendOutline, assemble, openSource, outlineSubset, PageCopier, saveDocument, type CopyStats } from '../pages/assembly';
import { afterInsert, labelStrings, readLabelRanges, writeLabelRanges, type LabelRange } from '../pages/labels';
import { contentStreams, cropBox, hashBytes, hashString, mediaBox, pageRefs, pageRotation, rawStreamBytes, type Doc, type Obj } from '../pages/pdf';
import { deletePages, dropTarget, insertBlankPages, movePages, reorderTo, retargetPageReferences, rotatePages } from '../pages/structure';
import { geometryOps } from '../pages/geometry-ops';
import { stampOps } from '../pages/stamp-ops';
import { splitOps } from '../pages/split-ops';

interface DocArg { docId: string }
interface PagesArg extends DocArg { pageIds: PageId[] }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'pages.insertBlank': { args: DocArg & { at: number; count?: number; size?: [number, number]; rotate?: number }; result: PageOpResult };
    'pages.insertFrom': { args: DocArg & { at: number; sources: PageSource[]; bookmarks?: boolean }; result: PageOpResult };
    'pages.delete': { args: PagesArg; result: PageOpResult };
    'pages.rotate': { args: PagesArg & { delta: number }; result: PageOpResult };
    'pages.duplicate': { args: PagesArg & { at?: number }; result: PageOpResult };
    'pages.move': { args: PagesArg & { before: number }; result: PageOpResult };
    'pages.reorder': { args: DocArg & { order: PageId[] }; result: PageOpResult };
    'pages.reverse': { args: DocArg & { pageIds?: PageId[] }; result: PageOpResult };
    'pages.interleave': { args: DocArg & { splitAt?: number; backReversed?: boolean }; result: PageOpResult };
    'pages.extract': { args: PagesArg & { each?: boolean; deleteAfter?: boolean; baseName?: string }; result: { files: OutputFile[]; op?: PageOpResult } };
    'pages.replace': { args: PagesArg & { source: PageSource }; result: PageOpResult };
    'pages.combine': { args: DocArg & { sources: (PageSource & { useOpenDocument?: boolean })[]; bookmarks?: boolean; labels?: boolean }; result: OutputFile };
    'pages.getLabels': { args: DocArg; result: { ranges: LabelRange[] | null; labels: string[] } };
    'pages.setLabels': { args: DocArg & { ranges: LabelRange[] | null }; result: PageOpResult };
    'pages.fingerprints': { args: DocArg & { pageIds: PageId[] }; result: Record<number, string> };
    'pages.boxes': { args: DocArg & { pageIds?: PageId[] }; result: PageBoxInfo[] };
  }
}

function withLabelsAfterInsert(pdf: Doc, at: number, count: number, before: LabelRange[] | null): void {
  writeLabelRanges(pdf, before ? afterInsert(before, at, count) : null, pdf.countPages());
}

function copyInto(pdf: Doc, at: number, sources: PageSource[], bookmarks: boolean): { created: Obj[]; stats: CopyStats[] } {
  const labels = readLabelRanges(pdf);
  const created: Obj[] = [];
  const stats: CopyStats[] = [];
  let where = Math.max(0, Math.min(at, pdf.countPages()));
  for (const source of sources) {
    const src = openSource(source.bytes, source.fitTo);
    try {
      const indices = sourcePages(src, source.pages);
      if (!indices.length) continue;
      const copier = new PageCopier(pdf, src);
      const pages = copier.copyPages(indices, where);
      if (bookmarks) {
        // Imported bookmarks go to the end of the outline, under the file name (off by default).
        const dest = pdf.newArray();
        dest.push(pages[0]);
        dest.push(pdf.newName('Fit'));
        appendOutline(pdf, [{ title: (source.name || 'Inserted pages').replace(/\.(pdf|png|jpe?g)$/i, ''), dest, open: false, children: outlineSubset(copier) }]);
      }
      stats.push(copier.finish());
      created.push(...pages);
      where += pages.length;
    } finally {
      src.destroy();
    }
  }
  if (!created.length) throw new Error('No pages to insert.');
  withLabelsAfterInsert(pdf, Math.max(0, Math.min(at, pdf.countPages())), created.length, labels);
  return { created, stats };
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.byteLength === bytes.byteLength && bytes.byteOffset === 0 ? (bytes.buffer as ArrayBuffer) : Uint8Array.from(bytes).buffer;
}

function fingerprint(page: Obj): string {
  let h = hashString(page.resolve().toString());
  const resources = page.getInheritable('Resources');
  if (resources.isDictionary()) {
    h = hashString(resources.resolve().toString(), h);
    const xobjects = resources.get('XObject');
    if (xobjects.isDictionary()) h = hashString(xobjects.resolve().toString(), h);
  }
  for (const stream of contentStreams(page)) if (stream.isStream()) h = hashBytes(rawStreamBytes(stream), h);
  const annots = page.get('Annots');
  if (annots.isArray()) {
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i);
      h = hashString(annot.resolve().toString(), h);
      let normal = annot.get('AP', 'N');
      if (normal.isDictionary() && !normal.isStream()) {
        const state = annot.get('AS');
        normal = state.isName() ? normal.get(state.asName()) : normal;
      }
      if (normal.isStream()) h = hashBytes(rawStreamBytes(normal), h);
    }
  }
  return h.toString(36);
}

const methods = {
  'pages.insertBlank': (ctx: EngineContext, args: DocArg & { at: number; count?: number; size?: [number, number]; rotate?: number }) => {
    const { pdf } = ctx.get(args.docId);
    let size = args.size;
    if (!size) {
      const ref = pdf.findPage(Math.max(0, Math.min(args.at, pdf.countPages()) - 1));
      const box = mediaBox(ref);
      size = [box[2] - box[0], box[3] - box[1]];
    }
    const count = args.count ?? 1;
    return pageMutation(ctx, args.docId, count === 1 ? 'Insert blank page' : `Insert ${count} blank pages`, [], (doc) => insertBlankPages(doc, args.at, count, size!, args.rotate ?? 0));
  },
  'pages.insertFrom': (ctx: EngineContext, args: DocArg & { at: number; sources: PageSource[]; bookmarks?: boolean }) => {
    if (!Array.isArray(args.sources) || !args.sources.length) throw new Error('Choose a file to insert.');
    let stats: CopyStats[] = [];
    const result = pageMutation(ctx, args.docId, 'Insert pages', [], (pdf) => {
      const copied = copyInto(pdf, args.at, args.sources, Boolean(args.bookmarks));
      stats = copied.stats;
      return copied.created;
    });
    result.renamedFields = stats.flatMap((s) => s.renamedFields);
    result.droppedLinks = stats.reduce((sum, s) => sum + s.droppedLinks, 0);
    return result;
  },
  'pages.delete': (ctx: EngineContext, args: PagesArg) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds);
    return pageMutation(ctx, args.docId, indices.length === 1 ? 'Delete page' : `Delete ${indices.length} pages`, [...args.pageIds], (pdf) => deletePages(pdf, indices));
  },
  'pages.rotate': (ctx: EngineContext, args: PagesArg & { delta: number }) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds);
    const label = args.delta === 90 ? 'Rotate clockwise' : args.delta === -90 || args.delta === 270 ? 'Rotate counterclockwise' : 'Rotate pages';
    return pageMutation(ctx, args.docId, label, [...args.pageIds], (pdf) => rotatePages(pdf, indices, args.delta));
  },
  'pages.duplicate': (ctx: EngineContext, args: PagesArg & { at?: number }) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds).sort((a, b) => a - b);
    const at = args.at ?? indices[indices.length - 1] + 1;
    let stats: CopyStats | undefined;
    const result = pageMutation(ctx, args.docId, indices.length === 1 ? 'Duplicate page' : `Duplicate ${indices.length} pages`, [], (pdf) => {
      if (!Number.isInteger(at) || at < 0 || at > pdf.countPages()) throw new Error('Insert position is outside this document.');
      const labels = readLabelRanges(pdf);
      const copier = new PageCopier(pdf, pdf);
      const created = copier.copyPages(indices, at);
      stats = copier.finish();
      withLabelsAfterInsert(pdf, at, created.length, labels);
      return created;
    });
    result.renamedFields = stats?.renamedFields ?? [];
    return result;
  },
  'pages.move': (ctx: EngineContext, args: PagesArg & { before: number }) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds);
    const { pdf } = ctx.get(args.docId);
    if (!Number.isInteger(args.before) || args.before < 0 || args.before > pdf.countPages()) throw new Error('Drop position is outside this document.');
    const to = dropTarget(pdf.countPages(), indices, args.before);
    return pageMutation(ctx, args.docId, indices.length === 1 ? 'Move page' : `Move ${indices.length} pages`, [...args.pageIds], (doc) => { movePages(doc, indices, to); });
  },
  'pages.reorder': (ctx: EngineContext, args: DocArg & { order: PageId[] }) => {
    const { pdf } = ctx.get(args.docId);
    if (!Array.isArray(args.order) || args.order.length !== pdf.countPages()) throw new Error('A reorder must list every page once.');
    const indices = indicesOf(ctx, args.docId, args.order);
    return pageMutation(ctx, args.docId, 'Reorder pages', 'all', (doc) => {
      const refs = pageRefs(doc);
      reorderTo(doc, indices.map((i) => refs[i]));
    });
  },
  'pages.reverse': (ctx: EngineContext, args: DocArg & { pageIds?: PageId[] }) => {
    const { pdf } = ctx.get(args.docId);
    const indices = args.pageIds?.length ? indicesOf(ctx, args.docId, args.pageIds).sort((a, b) => a - b) : Array.from({ length: pdf.countPages() }, (_, i) => i);
    return pageMutation(ctx, args.docId, 'Reverse pages', 'all', (doc) => {
      const refs = pageRefs(doc);
      const order = [...refs];
      const reversed = [...indices].reverse();
      indices.forEach((position, k) => { order[position] = refs[reversed[k]]; });
      reorderTo(doc, order);
    });
  },
  'pages.interleave': (ctx: EngineContext, args: DocArg & { splitAt?: number; backReversed?: boolean }) => {
    const { pdf } = ctx.get(args.docId);
    const count = pdf.countPages();
    const splitAt = args.splitAt ?? Math.ceil(count / 2);
    if (!Number.isInteger(splitAt) || splitAt < 1 || splitAt >= count) throw new Error('Choose where the back sides start.');
    return pageMutation(ctx, args.docId, 'Interleave pages', 'all', (doc) => {
      const refs = pageRefs(doc);
      const fronts = refs.slice(0, splitAt);
      const backs = refs.slice(splitAt);
      if (args.backReversed) backs.reverse();
      const order: Obj[] = [];
      for (let i = 0; i < Math.max(fronts.length, backs.length); i++) {
        if (i < fronts.length) order.push(fronts[i]);
        if (i < backs.length) order.push(backs[i]);
      }
      reorderTo(doc, order);
    });
  },
  'pages.extract': (ctx: EngineContext, args: PagesArg & { each?: boolean; deleteAfter?: boolean; baseName?: string }) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds).sort((a, b) => a - b);
    const { pdf } = ctx.get(args.docId);
    const base = (args.baseName || 'Pages').replace(/\.pdf$/i, '');
    const groups = args.each ? indices.map((i) => [i]) : [indices];
    const files: OutputFile[] = groups.map((group) => {
      const built = assemble([{ pdf, indices: group }], { bookmarks: 'subset', labels: true });
      try {
        const bytes = saveDocument(built.pdf);
        const name = args.each ? `${base} - page ${group[0] + 1}.pdf` : `${base} - pages.pdf`;
        return { name, bytes: ab(bytes), pageCount: group.length };
      } finally {
        built.pdf.destroy();
      }
    });
    if (!args.deleteAfter) return { files };
    if (indices.length >= pdf.countPages()) throw new Error('A document must keep at least one page. Extract without deleting, or keep one page.');
    const op = pageMutation(ctx, args.docId, indices.length === 1 ? 'Extract and delete page' : `Extract and delete ${indices.length} pages`, [...args.pageIds], (doc) => deletePages(doc, indices));
    return { files, op };
  },
  'pages.replace': (ctx: EngineContext, args: PagesArg & { source: PageSource }) => {
    const indices = indicesOf(ctx, args.docId, args.pageIds).sort((a, b) => a - b);
    for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1] + 1) throw new Error('Replace works on a continuous run of pages.');
    let stats: CopyStats | undefined;
    const result = pageMutation(ctx, args.docId, indices.length === 1 ? 'Replace page' : `Replace ${indices.length} pages`, [], (pdf) => {
      const src = openSource(args.source.bytes, args.source.fitTo);
      try {
        const sourceIndices = sourcePages(src, args.source.pages);
        if (!sourceIndices.length) throw new Error('Choose at least one replacement page.');
        const refs = pageRefs(pdf);
        const labels = readLabelRanges(pdf);
        const copier = new PageCopier(pdf, src);
        const created = copier.copyPages(sourceIndices, indices[0]);
        stats = copier.finish();
        const mapping = new Map<number, Obj>();
        indices.forEach((oldIndex, k) => mapping.set(refs[oldIndex].asIndirect(), created[Math.min(k, created.length - 1)]));
        retargetPageReferences(pdf, mapping);
        const shifted = indices.map((i) => i + created.length);
        deletePages(pdf, shifted);
        // Labels: replacement pages take the positions (and labels) of the pages they replace.
        writeLabelRanges(pdf, labels ? relabelReplace(labels, indices[0], indices.length, created.length) : null, pdf.countPages());
        return created;
      } finally {
        src.destroy();
      }
    });
    result.renamedFields = stats?.renamedFields ?? [];
    return result;
  },
  'pages.combine': (ctx: EngineContext, args: DocArg & { sources: (PageSource & { useOpenDocument?: boolean })[]; bookmarks?: boolean; labels?: boolean }) => {
    if (!Array.isArray(args.sources) || !args.sources.length) throw new Error('Add files to combine.');
    const opened: Doc[] = [];
    try {
      const parts = args.sources.map((source) => {
        const pdf = source.useOpenDocument ? ctx.get(args.docId).pdf : openSource(source.bytes, source.fitTo);
        if (!source.useOpenDocument) opened.push(pdf);
        return { pdf, indices: sourcePages(pdf, source.pages), title: (source.name || 'Document').replace(/\.(pdf|png|jpe?g)$/i, '') };
      });
      const built = assemble(parts, { bookmarks: args.bookmarks === false ? 'none' : 'per-source', labels: args.labels ?? false });
      try {
        const bytes = saveDocument(built.pdf);
        return { name: 'Combined.pdf', bytes: ab(bytes), pageCount: built.pdf.countPages() };
      } finally {
        built.pdf.destroy();
      }
    } finally {
      opened.forEach((pdf) => pdf.destroy());
    }
  },
  'pages.getLabels': (ctx: EngineContext, args: DocArg) => {
    const { pdf } = ctx.get(args.docId);
    const ranges = readLabelRanges(pdf);
    return { ranges, labels: labelStrings(ranges, pdf.countPages()) };
  },
  'pages.setLabels': (ctx: EngineContext, args: DocArg & { ranges: LabelRange[] | null }) =>
    pageMutation(ctx, args.docId, 'Edit page labels', 'all', (pdf) => writeLabelRanges(pdf, args.ranges, pdf.countPages())),
  'pages.fingerprints': (ctx: EngineContext, args: DocArg & { pageIds: PageId[] }) => {
    const { pdf } = ctx.get(args.docId);
    const out: Record<number, string> = {};
    for (const id of args.pageIds) {
      let index: number;
      try { index = ctx.pageIndex(args.docId, id); } catch { continue; }
      if (index >= pdf.countPages()) continue;
      out[id] = fingerprint(pdf.findPage(index));
    }
    return out;
  },
  'pages.boxes': (ctx: EngineContext, args: DocArg & { pageIds?: PageId[] }) => {
    const { pdf } = ctx.get(args.docId);
    const labels = labelStrings(readLabelRanges(pdf), pdf.countPages());
    const pages = ctx.pages(args.docId);
    const wanted = args.pageIds ? new Set(args.pageIds) : null;
    return pages.filter((page) => !wanted || wanted.has(page.id)).map((page) => {
      const ref = pdf.findPage(page.index);
      return { id: page.id, index: page.index, label: labels[page.index], rotation: pageRotation(ref), mediaBox: mediaBox(ref), cropBox: cropBox(ref) };
    });
  },
};

/** Replacement pages take the positions of the pages they replace: ranges after the run shift by
 * the size difference; ranges that started inside the run (other than at its first page) are
 * dropped when the page count changes. */
export function relabelReplace(ranges: LabelRange[], start: number, removed: number, added: number): LabelRange[] {
  if (removed === added) return ranges;
  return ranges
    .filter((range) => !(range.start > start && range.start < start + removed))
    .map((range) => (range.start >= start + removed ? { ...range, start: range.start - removed + added } : { ...range }));
}


export const namespace = 'pages';
export const ops = { ...methods, ...geometryOps, ...stampOps, ...splitOps } satisfies Record<string, (ctx: EngineContext, args: never, request: OperationRequest) => unknown>;
