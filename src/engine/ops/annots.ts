import type { EngineContext } from '../context';
import type { OpResult, PageId } from '../../shared/engine-api';
import type {
  AnnotCreateSpec,
  AnnotListResult,
  AnnotPatch,
  AnnotRef,
  AnnotSummary,
  FlattenScope,
} from '../tools/annots/types';
import {
  addReply,
  bakeAnnotations,
  createAnnot,
  deleteAnnots,
  findAnnot,
  isFillSign,
  isVisibleAnnot,
  patchAnnot,
  summarize,
  transformAnnot,
} from '../tools/annots/model';

type Matrix = [number, number, number, number, number, number];
interface DocArg {
  docId: string;
}
interface CreateArgs extends DocArg {
  pageId: PageId;
  spec: AnnotCreateSpec;
  label?: string;
}
interface UpdateArgs extends DocArg {
  pageId: PageId;
  id: number;
  patch: AnnotPatch;
  label?: string;
}
interface TransformArgs extends DocArg {
  pageId: PageId;
  ids: number[];
  matrix: Matrix;
  label?: string;
}
interface DeleteArgs extends DocArg {
  items: AnnotRef[];
  label?: string;
}
interface ReplyArgs extends DocArg {
  pageId: PageId;
  parentId: number;
  contents: string;
  author: string;
}
interface FlattenArgs extends DocArg {
  scope: FlattenScope;
  items?: AnnotRef[];
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'annots.list': { args: DocArg & { pageId?: PageId }; result: AnnotListResult };
    'annots.create': { args: CreateArgs; result: OpResult & { annotId: number } };
    'annots.update': { args: UpdateArgs; result: OpResult };
    'annots.transform': { args: TransformArgs; result: OpResult };
    'annots.delete': { args: DeleteArgs; result: OpResult & { deleted: number } };
    'annots.reply': { args: ReplyArgs; result: OpResult & { annotId: number } };
    'annots.flatten': { args: FlattenArgs; result: OpResult & { baked: number } };
  }
}

const LABELS: Record<string, string> = {
  Highlight: 'Add highlight',
  Underline: 'Add underline',
  StrikeOut: 'Add strike-through',
  Squiggly: 'Add squiggly underline',
  Text: 'Add sticky note',
  FreeText: 'Add text box',
  Square: 'Add rectangle',
  Circle: 'Add ellipse',
  Line: 'Add line',
  PolyLine: 'Add polyline',
  Polygon: 'Add polygon',
  Ink: 'Add drawing',
  Stamp: 'Add stamp',
};

function withPage<T>(ctx: EngineContext, docId: string, pageId: PageId, fn: (page: import('mupdf').PDFPage) => T): T {
  const page = ctx.get(docId).pdf.loadPage(ctx.pageIndex(docId, pageId));
  try {
    return fn(page);
  } finally {
    page.destroy();
  }
}

function list(ctx: EngineContext, args: DocArg & { pageId?: PageId }): AnnotListResult {
  const doc = ctx.get(args.docId);
  const items: AnnotSummary[] = [];
  const indices =
    args.pageId !== undefined
      ? [ctx.pageIndex(args.docId, args.pageId)]
      : Array.from({ length: doc.pdf.countPages() }, (_, i) => i);
  for (const index of indices) {
    const pageObject = doc.pdf.findPage(index);
    const annots = pageObject.get('Annots');
    const hasAnnots = annots.isArray() && annots.length > 0;
    if (!hasAnnots) continue;
    const pageId = args.pageId ?? ctx.pageInfo(args.docId, index).id;
    const page = doc.pdf.loadPage(index);
    try {
      for (const annot of page.getAnnotations()) {
        const type = annot.getType();
        if (type === 'Popup' || type === 'Link') continue;
        items.push(summarize(annot, pageId, index));
      }
    } finally {
      page.destroy();
    }
  }
  return { revision: doc.revision, items };
}

export const namespace = 'annots';
export const ops = {
  'annots.list': list,
  'annots.create': (ctx: EngineContext, args: CreateArgs) => {
    let annotId = 0;
    const result = ctx.mutate(
      args.docId,
      args.label || LABELS[args.spec.type] || 'Add comment',
      [args.pageId],
      (pdf) =>
        withPage(ctx, args.docId, args.pageId, (page) => {
          annotId = createAnnot(pdf, page, args.spec).getObject().asIndirect();
        }),
    );
    return { ...result, annotId };
  },
  'annots.update': (ctx: EngineContext, args: UpdateArgs) =>
    ctx.mutate(args.docId, args.label || 'Edit comment', [args.pageId], () =>
      withPage(ctx, args.docId, args.pageId, (page) => patchAnnot(findAnnot(page, args.id), args.patch)),
    ),
  'annots.transform': (ctx: EngineContext, args: TransformArgs) =>
    ctx.mutate(args.docId, args.label || 'Move comment', [args.pageId], () =>
      withPage(ctx, args.docId, args.pageId, (page) => {
        for (const id of new Set(args.ids)) transformAnnot(findAnnot(page, id), args.matrix);
      }),
    ),
  'annots.delete': (ctx: EngineContext, args: DeleteArgs) => {
    let deleted = 0;
    const byPage = new Map<PageId, number[]>();
    for (const item of args.items) byPage.set(item.pageId, [...(byPage.get(item.pageId) || []), item.id]);
    const result = ctx.mutate(
      args.docId,
      args.label || (args.items.length > 1 ? 'Delete comments' : 'Delete comment'),
      [...byPage.keys()],
      () => {
        for (const [pageId, ids] of byPage)
          withPage(ctx, args.docId, pageId, (page) => {
            for (const id of ids) findAnnot(page, id);
            deleted += deleteAnnots(page, ids).length;
          });
      },
    );
    return { ...result, deleted };
  },
  'annots.reply': (ctx: EngineContext, args: ReplyArgs) => {
    let annotId = 0;
    if (!args.contents.trim()) throw new Error('Write a reply first.');
    const result = ctx.mutate(args.docId, 'Reply to comment', [args.pageId], (pdf) =>
      withPage(ctx, args.docId, args.pageId, (page) => {
        annotId = addReply(pdf, page, findAnnot(page, args.parentId), args.contents, args.author)
          .getObject()
          .asIndirect();
      }),
    );
    return { ...result, annotId };
  },
  'annots.flatten': (ctx: EngineContext, args: FlattenArgs) => {
    let baked = 0;
    const wanted = new Set((args.items || []).map((item) => item.id));
    const label =
      args.scope === 'fill-sign'
        ? 'Flatten signatures into the page'
        : args.scope === 'selected'
          ? 'Flatten selected comments'
          : 'Flatten comments';
    const result = ctx.mutate(args.docId, label, 'all', (pdf) => {
      baked = bakeAnnotations(pdf, (annot, _subtype, id) => {
        if (!isVisibleAnnot(annot)) return false;
        if (args.scope === 'fill-sign') return isFillSign(annot);
        if (args.scope === 'selected') return wanted.has(id);
        return true;
      });
      if (!baked) throw new Error('NOTHING_TO_FLATTEN');
    });
    return { ...result, baked };
  },
};
