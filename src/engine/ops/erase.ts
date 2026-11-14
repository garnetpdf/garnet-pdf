import type { EngineContext } from '../context';
import type { OpResult, PageId, PageInfo, Rect } from '../../shared/engine-api';
import { normalizeRect } from '../tools/redact/geometry';
import { redactAnnotations } from '../tools/redact/apply';
import { erasePage, planPage, type ErasePlan } from '../tools/erase/apply';

export type EraseScope = 'page' | 'all';
export interface EraseReport extends OpResult {
  erasedPages: number;
  /** Pages left alone because they have a different size from the page the box was drawn on. */
  skippedPages: number;
  removedAnnotations: number;
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'erase.area': { args: { docId: string; pageId: PageId; rect: Rect; scope: EraseScope }; result: EraseReport };
  }
}

const MIN_SIZE = 1;

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Pages that show the same box in the same place: the same visible width and height (rotation already applied). */
export function sameSize(a: Pick<PageInfo, 'width' | 'height'>, b: Pick<PageInfo, 'width' | 'height'>): boolean {
  return Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

export const namespace = 'erase';
export const ops = {
  'erase.area': (ctx: EngineContext, args: { docId: string; pageId: PageId; rect: Rect; scope: EraseScope }): EraseReport => {
    const rect = normalizeRect(args.rect);
    if (rect[2] - rect[0] < MIN_SIZE || rect[3] - rect[1] < MIN_SIZE) throw new Error('Drag a box around the logo or stamp.');
    const { pdf } = ctx.get(args.docId);
    const sourceIndex = ctx.pageIndex(args.docId, args.pageId);
    const all = ctx.pages(args.docId);
    const source = all[sourceIndex];
    const targets = args.scope === 'all' ? all.filter((info) => sameSize(info, source)) : [source];
    const waiting = targets.filter((info) => {
      const page = pdf.loadPage(info.index);
      try {
        return redactAnnotations(page).length > 0;
      } finally {
        page.destroy();
      }
    });
    if (waiting.length) {
      const where = targets.length === 1 ? 'this page' : waiting.length === 1 ? `page ${waiting[0].label}` : plural(waiting.length, 'page');
      throw new Error(`Black-out marks are waiting on ${where}. Apply or remove them in Protect first.`);
    }
    const plans = targets
      .map((info) => ({ info, plan: planPage(pdf, info.index, rect, MIN_SIZE) }))
      .filter((entry): entry is { info: PageInfo; plan: ErasePlan } => entry.plan !== null);
    if (!plans.length) throw new Error('The box is outside the page.');
    let changedPages = 0;
    let removedAnnotations = 0;
    const label = plans.length === 1 ? 'Remove logo or stamp' : `Remove logo or stamp from ${plural(plans.length, 'page')}`;
    const result = ctx.mutate(args.docId, label, plans.map(({ info }) => info.id), (live) => {
      for (const { plan } of plans) {
        const outcome = erasePage(live, plan);
        if (outcome.changed) changedPages++;
        removedAnnotations += outcome.removedAnnotations;
      }
      if (!changedPages) throw new Error('Nothing to remove inside the box. Draw the box around the whole logo or stamp.');
    });
    return { ...result, erasedPages: changedPages, skippedPages: args.scope === 'all' ? all.length - targets.length : 0, removedAnnotations };
  },
};
