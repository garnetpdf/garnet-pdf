/** Shared types and helpers for the page operation modules. */
import type { EngineContext } from '../context';
import type { OpResult, PageId } from '../../shared/engine-api';
import { parsePageRange } from './range';
import type { Doc, Obj } from './pdf';

export interface PageOpResult extends OpResult {
  /** Page IDs created by the operation, in document order. */
  inserted?: PageId[];
  /** Engine time for the whole call, milliseconds. */
  elapsedMs?: number;
  /** Form fields renamed to avoid name collisions: [old, new]. */
  renamedFields?: [string, string][];
  /** Copied pages whose links or bookmarks pointed outside the copy and were dropped. */
  droppedLinks?: number;
}

export interface PageSource {
  /** PDF, PNG or JPEG bytes. */
  bytes: ArrayBuffer;
  /** Zero-based source pages, or a range string like "1-3, 7". Default: all pages. */
  pages?: number[] | string;
  name?: string;
  /** Images only: 'page' fits the image on a page the size of `fitTo`. Default: image size. */
  fitTo?: [number, number];
}

export interface OutputFile {
  name: string;
  bytes: ArrayBuffer;
  pageCount: number;
}

export interface PageBoxInfo {
  id: PageId;
  index: number;
  label: string;
  rotation: number;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
}

export function indicesOf(ctx: EngineContext, docId: string, pageIds: readonly PageId[]): number[] {
  if (!Array.isArray(pageIds) || !pageIds.length) throw new Error('Select at least one page.');
  const indices = pageIds.map((id) => ctx.pageIndex(docId, id));
  if (new Set(indices).size !== indices.length) throw new Error('The same page was selected twice.');
  return indices;
}

export function sourcePages(pdf: Doc, pages: number[] | string | undefined): number[] {
  const count = pdf.countPages();
  if (pages === undefined) return Array.from({ length: count }, (_, i) => i);
  if (typeof pages === 'string') return parsePageRange(pages, count, { keepOrder: true });
  for (const index of pages) if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('A source page is outside the file.');
  return [...pages];
}

/** Runs one journaled operation and returns the engine result plus the IDs of new page objects. */
export function pageMutation(ctx: EngineContext, docId: string, label: string, changed: PageId[] | 'all', fn: (pdf: Doc) => Obj[] | void): PageOpResult {
  const started = performance.now();
  let created: Obj[] = [];
  const result = ctx.mutate(docId, label, changed, (pdf) => { created = fn(pdf) || []; }) as PageOpResult;
  if (created.length) {
    const doc = ctx.get(docId);
    if (!doc.transaction) ctx.pages(docId);
    result.inserted = created.map((ref) => doc.objectToPageId.get(ref.asIndirect())).filter((id): id is PageId => id !== undefined);
    if (changed !== 'all' && !changed.length) result.changedPages = result.inserted;
  }
  result.elapsedMs = performance.now() - started;
  return result;
}

