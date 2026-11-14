import type { EngineContext } from '../context';
import type { OpResult, PageId } from '../../shared/engine-api';

declare module '../../shared/engine-api' {
  interface EngineOps {
    'example.pageCount': { args: { docId: string }; result: number };
    'example.rotate': { args: { docId: string; pageId: PageId; degrees?: 90 | 180 | 270 }; result: OpResult };
  }
}

export const namespace = 'example';
export const ops = {
  'example.pageCount': (ctx: EngineContext, args: { docId: string }) => ctx.get(args.docId).pdf.countPages(),
  'example.rotate': (ctx: EngineContext, args: { docId: string; pageId: PageId; degrees?: 90 | 180 | 270 }) => {
    const index = ctx.pageIndex(args.docId, args.pageId);
    const degrees = args.degrees ?? 90;
    if (![90, 180, 270].includes(degrees)) throw new Error('Rotation must be 90, 180, or 270 degrees.');
    return ctx.mutate(args.docId, `Rotate page ${index + 1}`, [args.pageId], pdf => {
      const page = pdf.loadPage(index);
      const rotation = page.getObject().getInheritable('Rotate');
      const current = rotation.isNull() ? 0 : Number(rotation.valueOf()) || 0;
      page.getObject().put('Rotate', (current + degrees) % 360);
      page.destroy();
    });
  },
};
