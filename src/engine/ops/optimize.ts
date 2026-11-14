import { deepCopy, type EngineContext } from '../context';
import type { OperationRequest } from './core';
import type { OpResult } from '../../shared/engine-api';
import { collectPageImages, reencode, writeReplacement, type ImageReplacement, type ImageUsage } from '../tools/optimize/images';
import { settingsProblem, type ReduceSettings } from '../tools/optimize/presets';
import { sanitizeDocument, SANITIZE_KEYS, type SanitizeOptions } from '../tools/security/sanitize';

export interface ReduceResult {
  /** True when the result would not be smaller: nothing should change. */
  kept: boolean;
  beforeSize: number;
  afterSize: number;
  imagesFound: number;
  imagesReplaced: number;
  replacements: ImageReplacement[];
  /** The reduced file, only when asked for. */
  bytes?: ArrayBuffer;
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'optimize.reduce': { args: { docId: string; settings: ReduceSettings; baselineSize: number; returnBytes?: boolean }; result: ReduceResult };
    'optimize.apply': { args: { docId: string; settings: ReduceSettings; replacements: ImageReplacement[] }; result: OpResult & { imagesReplaced: number } };
  }
}

function stripOptions(settings: ReduceSettings): SanitizeOptions | null {
  const options = Object.fromEntries(SANITIZE_KEYS.map(key => [key, false])) as SanitizeOptions;
  options.metadata = settings.removeMetadata;
  options.thumbnails = settings.removeThumbnails;
  options.embeddedFiles = settings.removeAttachments;
  return Object.values(options).some(Boolean) ? options : null;
}

function applyAll(pdf: import('mupdf').PDFDocument, settings: ReduceSettings, replacements: ImageReplacement[]): number {
  const done = new Set<number>();
  let replaced = 0;
  for (const replacement of replacements) if (writeReplacement(pdf, replacement, done) !== null) replaced++;
  const strip = stripOptions(settings);
  if (strip) sanitizeDocument(pdf, strip, false);
  if (settings.subsetFonts) pdf.subsetFonts();
  return replaced;
}

export const namespace = 'optimize';
export const ops = {
  /** Runs on a disposable copy: measures images page by page, re-encodes them and measures the saved size. */
  'optimize.reduce': async (ctx: EngineContext, args: { docId: string; settings: ReduceSettings; baselineSize: number; returnBytes?: boolean }, request: OperationRequest): Promise<ReduceResult> => {
    const problem = settingsProblem(args.settings);
    if (problem) throw new Error(problem);
    const { pdf } = ctx.get(args.docId);
    const pages = pdf.countPages();
    const usages = new Map<number, ImageUsage>();
    for (let i = 0; i < pages; i++) {
      if (request.cancelled()) throw new Error('CANCELLED');
      collectPageImages(pdf, i, usages);
      request.progress({ type: 'reduceProgress', phase: 'Checking pages', done: i + 1, total: pages });
      await request.yield();
    }
    const replacements: ImageReplacement[] = [];
    let index = 0;
    for (const usage of usages.values()) {
      if (request.cancelled()) throw new Error('CANCELLED');
      const replacement = reencode(pdf, usage, args.settings);
      if (replacement) replacements.push(replacement);
      request.progress({ type: 'reduceProgress', phase: 'Compressing images', done: ++index, total: usages.size });
      await request.yield();
    }
    request.progress({ type: 'reduceProgress', phase: 'Measuring the result', done: 0, total: 1 });
    const copy = deepCopy(pdf);
    let bytes: Uint8Array;
    try {
      applyAll(copy, args.settings, replacements);
      const buffer = copy.saveToBuffer('garbage=compact,compress,objstms');
      bytes = Uint8Array.from(buffer.asUint8Array());
      buffer.destroy();
    } finally { copy.destroy(); }
    const kept = bytes.byteLength >= args.baselineSize;
    return {
      kept,
      beforeSize: args.baselineSize,
      afterSize: kept ? args.baselineSize : bytes.byteLength,
      imagesFound: usages.size,
      imagesReplaced: kept ? 0 : replacements.length,
      replacements: kept ? [] : replacements,
      bytes: args.returnBytes && !kept ? bytes.buffer as ArrayBuffer : undefined,
    };
  },
  /** Applies the measured result to the live document as one undoable step. */
  'optimize.apply': (ctx: EngineContext, args: { docId: string; settings: ReduceSettings; replacements: ImageReplacement[] }) => {
    let imagesReplaced = 0;
    const result = ctx.mutate(args.docId, 'Reduce file size', 'all', pdf => { imagesReplaced = applyAll(pdf, args.settings, args.replacements); });
    return { ...result, imagesReplaced };
  },
};
