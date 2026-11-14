/** Mark area tool, mark selected text, and the recent-files thumbnail refresh after a redaction save. */
import { useSyncExternalStore } from 'react';
import type { EditPage, PluginContext, Point, Rect, Tool } from '../../plugin-host/types';
import { transformRect } from '../../plugin-host/geometry';
import type { TextRange } from '../../../engine/ops/redact';
import { errorText, tabFor } from './kit';

export const AREA_TOOL = 'protect.area';

interface Drag {
  docId: string;
  pageId: number;
  start: Point;
  end: Point;
}
let drag: Drag | null = null;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((listener) => listener());
};

function boundsOf(a: Point, b: Point): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function AreaOverlay({ page }: { page: EditPage }) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  if (!drag || drag.docId !== page.docId || drag.pageId !== page.pageId) return null;
  const box = transformRect(page.pageToView, boundsOf(drag.start, drag.end));
  const total = transformRect(page.pageToView, [0, 0, page.width, page.height]);
  return (
    <div
      className="p4b-area"
      data-testid="redact-area-preview"
      style={{
        left: `${(box[0] / total[2]) * 100}%`,
        top: `${(box[1] / total[3]) * 100}%`,
        width: `${((box[2] - box[0]) / total[2]) * 100}%`,
        height: `${((box[3] - box[1]) / total[3]) * 100}%`,
      }}
    />
  );
}

export function areaTool(ctx: PluginContext): Tool {
  return {
    id: AREA_TOOL,
    cursor: 'crosshair',
    overlay: AreaOverlay,
    onPointerDown: (page, point) => {
      drag = { docId: page.docId, pageId: page.pageId, start: point, end: point };
      emit();
    },
    onPointerMove: (page, point) => {
      if (!drag || drag.pageId !== page.pageId || drag.docId !== page.docId) return;
      drag.end = point;
      emit();
    },
    onPointerUp: (page, point) => {
      const current = drag;
      drag = null;
      emit();
      if (!current || current.pageId !== page.pageId || current.docId !== page.docId) return;
      const rect = boundsOf(current.start, point);
      if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) return;
      // Tool points are in unrotated page user space; redaction marks use MuPDF page space.
      const pageRect = transformRect(page.pageToView, rect);
      ctx.engine
        .call('redact.markAreas', { docId: page.docId, pageId: page.pageId, rects: [pageRect] })
        .then(() =>
          ctx.ui.toast('Area marked for redaction. Choose Apply redactions to remove it.'),
        )
        .catch((error) => ctx.ui.toast(errorText(error)));
    },
  };
}

/** Last non-empty text selection inside a page's text layer, kept so toolbar clicks do not lose it. */
let cachedSelection: { docId: string; pages: Map<number, TextRange[]> } | null = null;

function offsetWithin(span: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(span, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function readSelection(): Map<number, TextRange[]> | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const pages = new Map<number, TextRange[]>();
  for (let r = 0; r < selection.rangeCount; r++) {
    const range = selection.getRangeAt(r);
    for (const layer of document.querySelectorAll<HTMLElement>('.page-inner .text-layer')) {
      if (!range.intersectsNode(layer)) continue;
      const canvas = layer.parentElement?.querySelector<HTMLCanvasElement>('canvas[data-page]');
      const pageIndex = Number(canvas?.dataset.page) - 1;
      if (!(pageIndex >= 0)) continue;
      Array.from(layer.children).forEach((child, line) => {
        const span = child as HTMLElement;
        if (!range.intersectsNode(span)) return;
        const whole = document.createRange();
        whole.selectNodeContents(span);
        const length = span.textContent?.length ?? 0;
        const start =
          range.compareBoundaryPoints(Range.START_TO_START, whole) > 0
            ? offsetWithin(span, range.startContainer, range.startOffset)
            : 0;
        const end =
          range.compareBoundaryPoints(Range.END_TO_END, whole) < 0
            ? offsetWithin(span, range.endContainer, range.endOffset)
            : length;
        if (end > start)
          pages.set(pageIndex, [...(pages.get(pageIndex) || []), { line, start, end }]);
      });
    }
  }
  return pages.size ? pages : null;
}

export function watchSelection(ctx: PluginContext): () => void {
  const listener = () => {
    const doc = ctx.documents.active();
    if (!doc) return;
    const pages = readSelection();
    if (pages) cachedSelection = { docId: doc.docId, pages };
  };
  document.addEventListener('selectionchange', listener);
  return () => document.removeEventListener('selectionchange', listener);
}

export async function markSelection(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  const live = readSelection();
  const pages = live || (cachedSelection?.docId === doc.docId ? cachedSelection.pages : null);
  const tab = tabFor(doc.docId);
  if (!pages || !tab) {
    ctx.ui.toast('Select text on the page first, then choose Mark selection.');
    return;
  }
  try {
    await ctx.history.run('Mark selected text for redaction', async () => {
      for (const [pageIndex, ranges] of pages) {
        const page = tab.info.pages[pageIndex];
        if (page)
          await ctx.engine.call('redact.markTextRanges', {
            docId: doc.docId,
            pageId: page.id,
            ranges,
          });
      }
    });
    cachedSelection = null;
    document.getSelection()?.removeAllRanges();
    ctx.ui.toast('Selected text marked for redaction. Choose Apply redactions to remove it.');
  } catch (error) {
    ctx.ui.toast(errorText(error));
  }
}

/** Redraws the recent-files thumbnail from the redacted first page so the start screen shows no removed content. */
export async function refreshRecentThumbnail(ctx: PluginContext, docId: string): Promise<void> {
  const tab = tabFor(docId);
  const page = tab?.info.pages[0];
  if (!tab?.file.handle || !page) return;
  const result = await ctx.engine.call('core.render', {
    docId,
    pageId: page.id,
    scale: 180 / page.width,
    dpr: 1,
    cache: false,
  });
  if (!result.bitmap) return;
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  canvas.getContext('2d')?.drawImage(result.bitmap, 0, 0);
  result.bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob) await window.garnet.recent.setThumbnail(tab.file.handle, await blob.arrayBuffer());
}
