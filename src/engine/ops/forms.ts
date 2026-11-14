import type { EngineContext } from '../context';
import type { OpResult } from '../../shared/engine-api';
import type { FormsListResult, SetValueArgs } from '../tools/forms/types';
import {
  countCalculations,
  documentHasScripts,
  listWidgets,
  resetFields,
  runCalculations,
  setFieldValue,
} from '../tools/forms/model';

interface DocArg {
  docId: string;
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'forms.list': { args: DocArg; result: FormsListResult };
    'forms.setValue': { args: SetValueArgs; result: OpResult };
    'forms.reset': { args: DocArg; result: OpResult };
    'forms.flatten': { args: DocArg; result: OpResult };
    'forms.calculate': { args: DocArg; result: OpResult & { updated: number } };
  }
}

export const namespace = 'forms';
export const ops = {
  'forms.list': (ctx: EngineContext, args: DocArg): FormsListResult => {
    const doc = ctx.get(args.docId);
    const widgets = listWidgets(ctx, args.docId);
    const calculations = countCalculations(doc.pdf);
    return {
      revision: doc.revision,
      widgets,
      hasScripts: documentHasScripts(doc.pdf),
      supportedCalculations: calculations.supported,
      unsupportedCalculations: calculations.unsupported,
    };
  },
  'forms.setValue': (ctx: EngineContext, args: SetValueArgs) => {
    let pages: number[] = [args.pageId];
    const result = ctx.mutate(args.docId, 'Fill form field', [args.pageId], (pdf) => {
      pages = setFieldValue(ctx, args.docId, pdf, args);
    });
    return { ...result, changedPages: [...new Set([args.pageId, ...pages])] };
  },
  'forms.reset': (ctx: EngineContext, args: DocArg) => {
    let pages: number[] = [];
    const result = ctx.mutate(args.docId, 'Reset form', 'all', (pdf) => {
      pages = resetFields(ctx, args.docId, pdf);
    });
    return pages.length ? { ...result, changedPages: pages } : result;
  },
  'forms.flatten': (ctx: EngineContext, args: DocArg) =>
    ctx.mutate(args.docId, 'Flatten form', 'all', (pdf) => {
      if (!listWidgets(ctx, args.docId).length) throw new Error('This document has no form fields.');
      pdf.bake(false, true);
    }),
  'forms.calculate': (ctx: EngineContext, args: DocArg) => {
    let updated = 0;
    const result = ctx.mutate(args.docId, 'Calculate form fields', 'all', (pdf) => {
      updated = runCalculations(ctx, args.docId, pdf).updated;
    });
    return { ...result, updated };
  },
};
