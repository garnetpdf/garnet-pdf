import type { EngineContext } from '../context';
import type { OperationRequest } from './core';
import type { OpResult, PageId, Quad, Rect } from '../../shared/engine-api';
import { compileSpec, matchLine, type FindSpec } from '../tools/redact/patterns';
import { mergeLineQuads, normalizeRect, quadBounds } from '../tools/redact/geometry';
import { applyPage, lineTextAndQuads, markArea, overlayPage, redactAnnotations, residualText, type ApplyOptions, type Residual } from '../tools/redact/apply';

export interface RedactHit {
  id: string;
  pageId: PageId;
  pageIndex: number;
  text: string;
  before: string;
  after: string;
  label: string;
  quads: Quad[];
}
export interface RedactMark {
  id: string;
  pageId: PageId;
  pageIndex: number;
  rect: Rect;
  text: string;
}
interface ApplySummary {
  marks: number;
  redactedPages: number;
  removedAnnotations: number;
  residuals: Residual[];
}
/** When marks were applied the report is also the operation result, so the app picks up the change. */
export type ApplyReport = (ApplySummary & { applied: false }) | (ApplySummary & OpResult & { applied: true });
export interface TextRange { line: number; start: number; end: number }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'redact.markAreas': { args: { docId: string; pageId: PageId; rects: Rect[] }; result: OpResult };
    'redact.markTextRanges': { args: { docId: string; pageId: PageId; ranges: TextRange[] }; result: OpResult };
    'redact.find': { args: { docId: string; spec: FindSpec; limit?: number }; result: { hits: RedactHit[]; truncated: boolean } };
    'redact.markHits': { args: { docId: string; hits: { pageId: PageId; quads: Quad[] }[] }; result: OpResult };
    'redact.marks': { args: { docId: string }; result: RedactMark[] };
    'redact.removeMarks': { args: { docId: string; ids: string[] | 'all' }; result: OpResult };
    'redact.apply': { args: { docId: string; options: ApplyOptions }; result: ApplyReport };
  }
}

const MIN_SIZE = 1;

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function createMark(page: import('mupdf').PDFPage, area: { rect?: Rect; quads?: Quad[] }) {
  const annot = page.createAnnotation('Redact');
  if (area.quads?.length) annot.setQuadPoints(area.quads);
  else if (area.rect) annot.setRect(area.rect);
  annot.update();
}

export const namespace = 'redact';
export const ops = {
  'redact.markAreas': (ctx: EngineContext, args: { docId: string; pageId: PageId; rects: Rect[] }) => {
    const rects = args.rects.map(normalizeRect).filter(r => r[2] - r[0] >= MIN_SIZE && r[3] - r[1] >= MIN_SIZE);
    if (!rects.length) throw new Error('Drag across the area you want to remove.');
    const index = ctx.pageIndex(args.docId, args.pageId);
    return ctx.mutate(args.docId, rects.length === 1 ? 'Mark area for redaction' : `Mark ${plural(rects.length, 'area')} for redaction`, [args.pageId], pdf => {
      const page = pdf.loadPage(index);
      try {
        const bounds = page.getBounds();
        for (const rect of rects) {
          const clipped: Rect = [Math.max(rect[0], bounds[0]), Math.max(rect[1], bounds[1]), Math.min(rect[2], bounds[2]), Math.min(rect[3], bounds[3])];
          if (clipped[2] - clipped[0] >= MIN_SIZE && clipped[3] - clipped[1] >= MIN_SIZE) createMark(page, { rect: clipped });
        }
      } finally { page.destroy(); }
    });
  },
  'redact.markTextRanges': (ctx: EngineContext, args: { docId: string; pageId: PageId; ranges: TextRange[] }) => {
    const index = ctx.pageIndex(args.docId, args.pageId);
    const { pdf } = ctx.get(args.docId);
    const page = pdf.loadPage(index);
    const groups: Quad[] = [];
    try {
      const lines = lineTextAndQuads(page);
      for (const range of args.ranges) {
        const line = lines[range.line];
        if (!line) continue;
        const quads = line.chars.filter(char => char.end > range.start && char.start < range.end && char.c.trim()).map(char => char.quad);
        if (quads.length) groups.push(mergeLineQuads(quads, line.direction));
      }
    } finally { page.destroy(); }
    if (!groups.length) throw new Error('Select text on the page first.');
    return ctx.mutate(args.docId, 'Mark selected text for redaction', [args.pageId], live => {
      const target = live.loadPage(index);
      try { createMark(target, { quads: groups }); } finally { target.destroy(); }
    });
  },
  'redact.find': async (ctx: EngineContext, args: { docId: string; spec: FindSpec; limit?: number }, request: OperationRequest) => {
    const compiled = compileSpec(args.spec);
    const { pdf } = ctx.get(args.docId);
    const limit = Math.min(args.limit ?? 5000, 20000);
    const hits: RedactHit[] = [];
    let truncated = false;
    const count = pdf.countPages();
    for (let i = 0; i < count && !truncated; i++) {
      if (request.cancelled()) throw new Error('CANCELLED');
      const page = pdf.loadPage(i);
      const pageId = ctx.pageInfo(args.docId, i).id;
      try {
        const lines = lineTextAndQuads(page);
        lines.forEach((line, lineIndex) => {
          for (const match of matchLine(line.text, compiled)) {
            if (hits.length >= limit) { truncated = true; return; }
            const quads = line.chars.filter(char => char.end > match.start && char.start < match.end && char.c.trim()).map(char => char.quad);
            if (!quads.length) continue;
            hits.push({
              id: `${pageId}:${lineIndex}:${match.start}`,
              pageId,
              pageIndex: i,
              text: line.text.slice(match.start, match.end),
              before: line.text.slice(Math.max(0, match.start - 32), match.start),
              after: line.text.slice(match.end, match.end + 32),
              label: match.label,
              quads: [mergeLineQuads(quads, line.direction)],
            });
          }
        });
      } finally { page.destroy(); }
      request.progress({ type: 'redactFindProgress', page: i + 1, pages: count, hits: hits.length });
      await request.yield();
    }
    return { hits, truncated };
  },
  'redact.markHits': (ctx: EngineContext, args: { docId: string; hits: { pageId: PageId; quads: Quad[] }[] }) => {
    const byPage = new Map<number, Quad[][]>();
    for (const hit of args.hits) {
      if (!hit.quads.length) continue;
      const index = ctx.pageIndex(args.docId, hit.pageId);
      byPage.set(index, [...(byPage.get(index) ?? []), hit.quads]);
    }
    if (!byPage.size) throw new Error('Choose at least one result to mark.');
    const pageIds = [...new Set(args.hits.map(hit => hit.pageId))];
    return ctx.mutate(args.docId, `Mark ${plural(args.hits.length, 'result')} for redaction`, pageIds, pdf => {
      for (const [index, groups] of byPage) {
        const page = pdf.loadPage(index);
        try { for (const quads of groups) createMark(page, { quads }); } finally { page.destroy(); }
      }
    });
  },
  'redact.marks': (ctx: EngineContext, args: { docId: string }) => {
    const { pdf } = ctx.get(args.docId);
    const marks: RedactMark[] = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      const page = pdf.loadPage(i);
      try {
        const annots = redactAnnotations(page);
        if (!annots.length) continue;
        const pageId = ctx.pageInfo(args.docId, i).id;
        const lines = lineTextAndQuads(page);
        for (const annot of annots) {
          const area = markArea(annot);
          let text = '';
          for (const line of lines) for (const char of line.chars) {
            const box = quadBounds(char.quad);
            const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
            const inside = area.quads.length ? area.quads.some(q => { const b = quadBounds(q); return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]; }) : cx >= area.rect[0] && cx <= area.rect[2] && cy >= area.rect[1] && cy <= area.rect[3];
            if (inside) text += char.c;
          }
          marks.push({ id: `${pageId}:${annot.getObject().asIndirect()}`, pageId, pageIndex: i, rect: area.rect, text: text.trim().slice(0, 80) });
        }
      } finally { page.destroy(); }
    }
    return marks;
  },
  'redact.removeMarks': (ctx: EngineContext, args: { docId: string; ids: string[] | 'all' }) => {
    const { pdf } = ctx.get(args.docId);
    const wanted = args.ids === 'all' ? null : new Set(args.ids);
    const targets: { index: number; nums: Set<number> | null; pageId: PageId }[] = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      const pageId = ctx.pageInfo(args.docId, i).id;
      if (wanted) {
        const nums = new Set([...wanted].filter(id => id.startsWith(`${pageId}:`)).map(id => Number(id.split(':')[1])));
        if (nums.size) targets.push({ index: i, nums, pageId });
      } else targets.push({ index: i, nums: null, pageId });
    }
    let removed = 0;
    const result = ctx.mutate(args.docId, 'Remove redaction marks', targets.map(t => t.pageId), live => {
      for (const target of targets) {
        const page = live.loadPage(target.index);
        try {
          for (const annot of redactAnnotations(page)) {
            if (target.nums && !target.nums.has(annot.getObject().asIndirect())) continue;
            page.deleteAnnotation(annot);
            removed++;
          }
        } finally { page.destroy(); }
      }
    });
    if (!removed && args.ids !== 'all') throw new Error('Those redaction marks are no longer in the document.');
    return result;
  },
  'redact.apply': (ctx: EngineContext, args: { docId: string; options: ApplyOptions }): ApplyReport => {
    const { pdf } = ctx.get(args.docId);
    const pages: { index: number; pageId: PageId; marks: number }[] = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      const page = pdf.loadPage(i);
      try {
        const count = redactAnnotations(page).length;
        if (count) pages.push({ index: i, pageId: ctx.pageInfo(args.docId, i).id, marks: count });
      } finally { page.destroy(); }
    }
    const marks = pages.reduce((sum, page) => sum + page.marks, 0);
    if (!marks) return { applied: false, marks: 0, redactedPages: 0, removedAnnotations: 0, residuals: [] };
    let removedAnnotations = 0;
    const residuals: Residual[] = [];
    const result = ctx.mutate(args.docId, `Apply ${plural(marks, 'redaction')}`, pages.map(page => page.pageId), live => {
      for (const page of pages) {
        const outcome = applyPage(live, page.index, args.options);
        removedAnnotations += outcome.removedAnnotations;
        residuals.push(...residualText(live, page.index, outcome.areas));
        overlayPage(live, page.index, outcome.areas, args.options);
      }
    });
    return { ...result, applied: true, marks, redactedPages: pages.length, removedAnnotations, residuals };
  },
};
