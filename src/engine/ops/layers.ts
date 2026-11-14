import type { EngineContext } from '../context';
import type { OpResult } from '../../shared/engine-api';

export interface LayerInfo { index: number; name: string; visible: boolean }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'layers.list': { args: { docId: string }; result: LayerInfo[] };
    /** View state only (like other PDF readers): affects display, printing and export, not the saved file. */
    'layers.setVisible': { args: { docId: string; index: number; visible: boolean }; result: OpResult };
  }
}

export const namespace = 'layers';
export const ops = {
  'layers.list': (ctx: EngineContext, args: { docId: string }) => {
    const { pdf } = ctx.get(args.docId);
    return Array.from({ length: pdf.countLayers() }, (_, index) => ({ index, name: pdf.getLayerName(index) || `Layer ${index + 1}`, visible: pdf.isLayerVisible(index) }));
  },
  'layers.setVisible': (ctx: EngineContext, args: { docId: string; index: number; visible: boolean }) => {
    const { pdf } = ctx.get(args.docId);
    if (!Number.isInteger(args.index) || args.index < 0 || args.index >= pdf.countLayers()) throw new Error('This layer is no longer in the document.');
    pdf.setLayerVisible(args.index, args.visible);
    // New revision so cached page images are rendered again; the journal and saved state are untouched.
    return ctx.travelled(args.docId);
  },
};
