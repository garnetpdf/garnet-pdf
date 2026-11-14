/** Organize view state: page selection per document, thumbnail size, page fingerprints. */
import { create } from 'zustand';
import type { PageId, PageInfo } from '../../../shared/engine-api';

export interface DocSelection {
  ids: PageId[];
  anchor?: PageId;
  focus?: PageId;
}

const SIZE_KEY = 'garnet.organize.thumbWidth';
export const MIN_THUMB = 96;
export const MAX_THUMB = 320;

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(SIZE_KEY));
    if (value >= MIN_THUMB && value <= MAX_THUMB) return value;
  } catch {
    /* Storage unavailable: use the default. */
  }
  return 150;
}

export interface OrganizeState {
  selection: Record<string, DocSelection>;
  thumbWidth: number;
  /** Content fingerprints by document and page id; a changed value means the thumbnail changed. */
  fingerprints: Record<string, Record<number, string>>;
  /** Thumbnail renders requested from the engine (cache misses), for diagnostics and tests. */
  renders: number;
  /** Start time of the last drag-and-drop or keyboard reorder, for the timing readout. */
  pendingSince: number | null;
  lastOpMs: number | null;
  select(docId: string, patch: DocSelection): void;
  setThumbWidth(width: number): void;
  setFingerprints(docId: string, values: Record<number, string>): void;
  countRender(): void;
  startTiming(): void;
  finishTiming(): void;
}

export const useOrganize = create<OrganizeState>((set, get) => ({
  selection: {},
  thumbWidth: storedWidth(),
  fingerprints: {},
  renders: 0,
  pendingSince: null,
  lastOpMs: null,
  select: (docId, patch) => set((s) => ({ selection: { ...s.selection, [docId]: patch } })),
  setThumbWidth: (width) => {
    const value = Math.round(Math.max(MIN_THUMB, Math.min(MAX_THUMB, width)));
    try {
      localStorage.setItem(SIZE_KEY, String(value));
    } catch {
      /* Not persisted. */
    }
    set({ thumbWidth: value });
  },
  setFingerprints: (docId, values) =>
    set((s) => ({ fingerprints: { ...s.fingerprints, [docId]: values } })),
  countRender: () => set((s) => ({ renders: s.renders + 1 })),
  startTiming: () => set({ pendingSince: performance.now() }),
  finishTiming: () => {
    const since = get().pendingSince;
    if (since !== null) set({ pendingSince: null, lastOpMs: performance.now() - since });
  },
}));

const EMPTY: DocSelection = { ids: [] };

export function selectionOf(docId: string): DocSelection {
  return useOrganize.getState().selection[docId] ?? EMPTY;
}

/** Selected pages that still exist, in document order. */
export function selectedInOrder(docId: string, pages: readonly PageInfo[]): PageId[] {
  const chosen = new Set(selectionOf(docId).ids);
  if (!chosen.size) return [];
  return pages.filter((p) => chosen.has(p.id)).map((p) => p.id);
}

export function clearSelection(docId: string): void {
  useOrganize.getState().select(docId, { ids: [] });
}
