import type { EngineContext } from '../context';
import type { OperationRequest } from '../ops/core';
import { assemble, saveDocument } from './assembly';
import type { OutputFile } from './common';
import { nameParts, splitGroups, type SplitOptions } from './split';

interface DocArg { docId: string }
export interface SplitPlanItem { name: string; first: number; last: number; pageCount: number; estimatedBytes?: number; oversize?: boolean }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'pages.splitPlan': { args: DocArg & SplitOptions; result: SplitPlanItem[] };
    'pages.split': { args: DocArg & SplitOptions; result: { files: (OutputFile & { oversize?: boolean })[] } };
  }
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength ? (bytes.buffer as ArrayBuffer) : Uint8Array.from(bytes).buffer;
}

export const splitOps = {
  'pages.splitPlan': (ctx: EngineContext, args: DocArg & SplitOptions): SplitPlanItem[] => {
    const { pdf } = ctx.get(args.docId);
    return nameParts(splitGroups(pdf, args), args).map((part) => ({
      name: part.name, first: part.pages[0] + 1, last: part.pages[part.pages.length - 1] + 1, pageCount: part.pages.length, estimatedBytes: part.estimatedBytes, oversize: part.oversize,
    }));
  },
  'pages.split': async (ctx: EngineContext, args: DocArg & SplitOptions, request: OperationRequest) => {
    const { pdf } = ctx.get(args.docId);
    const parts = nameParts(splitGroups(pdf, args), args);
    if (parts.length > 2000) throw new Error('That would make more than 2,000 files. Choose larger parts.');
    const files: (OutputFile & { oversize?: boolean })[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (request.cancelled()) throw new Error('CANCELLED');
      const built = assemble([{ pdf, indices: parts[i].pages }], { bookmarks: 'subset', labels: true });
      try {
        files.push({ name: parts[i].name, bytes: ab(saveDocument(built.pdf)), pageCount: parts[i].pages.length, oversize: parts[i].oversize });
      } finally {
        built.pdf.destroy();
      }
      request.progress({ done: i + 1, total: parts.length });
      if (i % 4 === 3) await request.yield();
    }
    return { files };
  },
};
