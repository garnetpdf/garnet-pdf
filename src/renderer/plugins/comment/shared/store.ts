/**
 * Annotation state shared by the Comment and Fill & Sign plugins: the engine's annotation list for the
 * active document, the selected annotation, drafts that are being typed, and wrappers around the
 * annotation engine ops. Each wrapper is one engine call, so each user gesture is one undo step.
 */
import { create } from 'zustand';
import type { Quad } from '../../../../shared/engine-api';
import type { PluginContext } from '../../../plugin-host/types';
import { activeTab, useApp } from '../../../store';
import type {
  AnnotCreateSpec,
  AnnotPatch,
  AnnotRef,
  AnnotSummary,
  FlattenScope,
} from '../../../../engine/tools/annots/types';
import type { Point } from '../../../plugin-host/types';
import { pageModel, pRectToU } from './geometry';

export type { AnnotSummary, AnnotRef, AnnotCreateSpec, AnnotPatch };
type Matrix = [number, number, number, number, number, number];

export interface Draft {
  kind: 'note' | 'freetext';
  pageId: number;
  point: Point;
  spec: Partial<AnnotCreateSpec>;
}

interface AnnotState {
  docId: string | null;
  revision: number;
  items: AnnotSummary[];
  selected: AnnotRef | null;
  /** FreeText being edited in place. */
  editing: AnnotRef | null;
  /** Sticky note whose pop-up is open. */
  popup: AnnotRef | null;
  draft: Draft | null;
  textSelection: { pageId: number; quads: Quad[]; text: string } | null;
  set: (patch: Partial<Omit<AnnotState, 'set'>>) => void;
}

export const useAnnots = create<AnnotState>((set) => ({
  docId: null,
  revision: -1,
  items: [],
  selected: null,
  editing: null,
  popup: null,
  draft: null,
  textSelection: null,
  set: (patch) => set(patch),
}));

let context: PluginContext | null = null;
let refreshing: Promise<void> | null = null;
let again = false;
const sameRef = (a: AnnotRef | null, b: AnnotRef | null) =>
  !!a && !!b && a.id === b.id && a.pageId === b.pageId;
export const refKey = (r: AnnotRef) => `${r.pageId}:${r.id}`;

export function findItem(ref: AnnotRef | null): AnnotSummary | undefined {
  if (!ref) return undefined;
  return useAnnots.getState().items.find((a) => a.id === ref.id && a.pageId === ref.pageId);
}

export function itemsOnPage(pageId: number): AnnotSummary[] {
  return useAnnots.getState().items.filter((a) => a.pageId === pageId);
}

/** Re-reads the annotation list when the document or its revision changed (or when forced). */
export function refreshAnnots(force = false): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      const tab = activeTab();
      const state = useAnnots.getState();
      if (!tab || !context) {
        if (state.docId) useAnnots.getState().set({ docId: null, items: [], selected: null, editing: null, popup: null, draft: null, textSelection: null });
        continue;
      }
      if (!force && state.docId === tab.info.docId && state.revision === tab.info.revision) continue;
      force = false;
      try {
        const list = await context.engine.call('annots.list', { docId: tab.info.docId });
        const current = activeTab();
        if (!current || current.info.docId !== tab.info.docId) {
          again = true;
          continue;
        }
        const changedDoc = state.docId !== tab.info.docId;
        const keep = (r: AnnotRef | null) =>
          !changedDoc && r && list.items.some((a) => a.id === r.id && a.pageId === r.pageId) ? r : null;
        useAnnots.getState().set({
          docId: tab.info.docId,
          revision: tab.info.revision,
          items: list.items,
          selected: keep(useAnnots.getState().selected),
          editing: keep(useAnnots.getState().editing),
          popup: keep(useAnnots.getState().popup),
          draft: changedDoc ? null : useAnnots.getState().draft,
          textSelection: changedDoc ? null : useAnnots.getState().textSelection,
        });
      } catch {
        // The document may have closed while listing; the next change triggers a new read.
      }
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const owners = new Set<string>();
/** Connects the store to the app state. Shared by plugins; the first connection does the work. */
export function connectAnnotStore(ctx: PluginContext, owner: string): () => void {
  owners.add(owner);
  if (!context) context = ctx;
  const unsubscribe = useApp.subscribe((s, previous) => {
    const tab = s.tabs.find((t) => t.info.docId === s.activeId);
    const before = previous.tabs.find((t) => t.info.docId === previous.activeId);
    if (s.activeId !== previous.activeId || tab?.info.revision !== before?.info.revision) void refreshAnnots();
  });
  void refreshAnnots();
  const offSelection = useAnnots.subscribe((s, previous) => {
    if (s.selected === previous.selected && s.items === previous.items) return;
    publishSelection();
  });
  return () => {
    unsubscribe();
    offSelection();
    owners.delete(owner);
    if (!owners.size) context = null;
  };
}

let publishing = false;
/** Mirrors the selected annotation into the host selection so the shell Inspector shows it. */
function publishSelection() {
  if (!context || publishing) return;
  publishing = true;
  try {
    const item = findItem(useAnnots.getState().selected);
    const tab = activeTab();
    const info = item && tab?.info.pages.find((p) => p.id === item.pageId);
    const current = context.selection.get();
    if (!item || !info || !tab) {
      if (current.some((s) => s.providerId === 'annotations')) context.selection.set([]);
      return;
    }
    context.selection.set([
      {
        id: `annot:${item.pageId}:${item.id}`,
        providerId: 'annotations',
        kind: 'annotation',
        pageId: item.pageId,
        bounds: pRectToU(pageModel(tab.info.docId, info), item.bounds),
        data: item,
      },
    ]);
  } finally {
    publishing = false;
  }
}

export function select(ref: AnnotRef | null, options: { inspector?: boolean } = {}) {
  const state = useAnnots.getState();
  if (sameRef(state.selected, ref) && !options.inspector) return;
  state.set({
    selected: ref,
    editing: sameRef(state.editing, ref) ? state.editing : null,
    popup: sameRef(state.popup, ref) ? state.popup : null,
    textSelection: ref ? null : state.textSelection,
  });
  if (ref && options.inspector) useApp.getState().set({ inspector: true });
}

function ctx(): PluginContext {
  if (!context) throw new Error('Annotations are not ready yet.');
  return context;
}

function report(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'NOTHING_TO_FLATTEN') ctx().ui.toast('There is nothing to flatten.');
  else ctx().ui.toast(message.replace(/^Error:\s*/, ''));
}

export function notify(message: string) {
  context?.ui.toast(message);
}

export function authorName(): string {
  return context?.settings.get().authorName?.trim() || '';
}

function docId(): string {
  const tab = activeTab();
  if (!tab) throw new Error('Open a document first.');
  return tab.info.docId;
}

export async function createAnnotation(
  pageId: number,
  spec: AnnotCreateSpec,
  options: { select?: boolean; label?: string } = { select: true },
): Promise<AnnotRef | null> {
  try {
    const author = spec.author ?? authorName();
    const result = await ctx().engine.call('annots.create', {
      docId: docId(),
      pageId,
      spec: { ...spec, author: author || undefined },
      label: options.label,
    });
    await refreshAnnots(true);
    const ref = { pageId, id: result.annotId };
    if (options.select !== false) select(ref);
    return ref;
  } catch (error) {
    report(error);
    return null;
  }
}

export async function updateAnnotation(ref: AnnotRef, patch: AnnotPatch, label?: string) {
  try {
    await ctx().engine.call('annots.update', { docId: docId(), pageId: ref.pageId, id: ref.id, patch, label });
    await refreshAnnots(true);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function transformAnnotations(refs: AnnotRef[], matrix: Matrix, label?: string) {
  if (!refs.length) return false;
  try {
    await ctx().engine.call('annots.transform', {
      docId: docId(),
      pageId: refs[0].pageId,
      ids: refs.map((r) => r.id),
      matrix,
      label,
    });
    await refreshAnnots(true);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function deleteAnnotations(refs: AnnotRef[]) {
  if (!refs.length) return false;
  try {
    await ctx().engine.call('annots.delete', { docId: docId(), items: refs });
    useAnnots.getState().set({ selected: null, editing: null, popup: null });
    await refreshAnnots(true);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function replyToAnnotation(ref: AnnotRef, contents: string) {
  try {
    await ctx().engine.call('annots.reply', {
      docId: docId(),
      pageId: ref.pageId,
      parentId: ref.id,
      contents,
      author: authorName(),
    });
    await refreshAnnots(true);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function flattenAnnotations(scope: FlattenScope, items?: AnnotRef[]) {
  try {
    const result = await ctx().engine.call('annots.flatten', { docId: docId(), scope, items });
    useAnnots.getState().set({ selected: null, editing: null, popup: null });
    await refreshAnnots(true);
    return result.baked;
  } catch (error) {
    report(error);
    return 0;
  }
}

/** Page text lines for markup selection, cached per document revision and page. */
const textCache = new Map<string, Promise<import('../../../../shared/engine-api').TextLine[]>>();
export function pageLines(page: { docId: string; pageId: number }) {
  const tab = activeTab();
  const key = `${page.docId}:${tab?.info.revision ?? 0}:${page.pageId}`;
  let lines = textCache.get(key);
  if (!lines) {
    if (textCache.size > 40) textCache.clear();
    lines = ctx()
      .engine.call('core.text', { docId: page.docId, pageId: page.pageId })
      .then((r) => r.lines)
      .catch(() => []);
    textCache.set(key, lines);
  }
  return lines;
}
