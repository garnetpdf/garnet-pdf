/** Remove logo or stamp: drag a box in the Edit tab and everything inside it leaves the page (this page or every page of its size). */
import { Eraser } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { definePlugin, type EditPage, type PluginContext, type Point, type Rect, type Tool } from '../../plugin-host/types';
import { transformRect } from '../../plugin-host/geometry';
import { useApp } from '../../store';
import type { EraseScope } from '../../../engine/ops/erase';
import { errorText, openDialog, tabFor } from '../protect/kit';
import './erase.css';

export const ERASE_TOOL = 'erase.area';

interface Box {
  docId: string;
  pageId: number;
  start: Point;
  end: Point;
}
/** The box being dragged, or waiting for the choice in the dialog. */
let box: Box | null = null;
let busy = false;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((listener) => listener());
};

function boundsOf(a: Point, b: Point): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function BoxOverlay({ page }: { page: EditPage }) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  if (!box || box.docId !== page.docId || box.pageId !== page.pageId) return null;
  const rect = transformRect(page.pageToView, boundsOf(box.start, box.end));
  const total = transformRect(page.pageToView, [0, 0, page.width, page.height]);
  return (
    <div
      className="erase-box"
      data-testid="erase-box-preview"
      style={{
        left: `${(rect[0] / total[2]) * 100}%`,
        top: `${(rect[1] / total[3]) * 100}%`,
        width: `${((rect[2] - rect[0]) / total[2]) * 100}%`,
        height: `${((rect[3] - rect[1]) / total[3]) * 100}%`,
      }}
    />
  );
}

function ScopeForm({ matching, total, close }: { matching: number; total: number; close: (scope?: EraseScope) => void }) {
  const [scope, setScope] = useState<EraseScope>('page');
  return (
    <div className="p4b-form" data-testid="erase-dialog">
      <p className="erase-lead">
        Everything inside the box will be removed: text, drawings, pictures and stamps. Undo brings it back.
      </p>
      {matching > 1 && (
        <section className="p4b-section" role="radiogroup" aria-label="Pages">
          <label className="p4b-check">
            <input type="radio" name="erase-scope" checked={scope === 'page'} onChange={() => setScope('page')} />
            <span>This page only</span>
          </label>
          <label className="p4b-check">
            <input type="radio" name="erase-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
            <span>
              {matching === total ? `Every page (${matching})` : `Every page of this size (${matching} of ${total})`}
              <small>For a logo or stamp in the same place on each page, like a letterhead.</small>
            </span>
          </label>
        </section>
      )}
      <footer>
        <button type="button" onClick={() => close()}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => close(scope)}>
          Remove
        </button>
      </footer>
    </div>
  );
}

async function erase(ctx: PluginContext, page: EditPage, rect: Rect): Promise<void> {
  const tab = tabFor(page.docId);
  const pages = tab?.info.pages ?? [];
  const source = pages.find((info) => info.id === page.pageId);
  const matching = source
    ? pages.filter((info) => Math.abs(info.width - source.width) < 0.5 && Math.abs(info.height - source.height) < 0.5).length
    : 1;
  const scope = await openDialog<EraseScope>('Remove logo or stamp', (close) => (
    <ScopeForm matching={matching} total={pages.length} close={close} />
  ));
  if (!scope) return;
  busy = true;
  try {
    const report = await ctx.engine.call('erase.area', { docId: page.docId, pageId: page.pageId, rect, scope });
    let message = scope === 'page' ? 'Removed from this page.' : `Removed from ${plural(report.erasedPages, 'page')}.`;
    if (report.skippedPages) message += ` ${plural(report.skippedPages, 'page')} of a different size left as they were.`;
    ctx.ui.toast(`${message} Undo brings it back.`);
  } finally {
    busy = false;
  }
}

function eraseTool(ctx: PluginContext): Tool {
  return {
    id: ERASE_TOOL,
    cursor: 'crosshair',
    overlay: BoxOverlay,
    onPointerDown: (page, point) => {
      if (busy) return;
      box = { docId: page.docId, pageId: page.pageId, start: point, end: point };
      emit();
    },
    onPointerMove: (page, point) => {
      if (busy || !box || box.pageId !== page.pageId || box.docId !== page.docId) return;
      box.end = point;
      emit();
    },
    onPointerUp: (page, point) => {
      if (busy) return;
      const current = box;
      if (!current || current.pageId !== page.pageId || current.docId !== page.docId) {
        box = null;
        emit();
        return;
      }
      current.end = point;
      const rect = boundsOf(current.start, point);
      if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) {
        box = null;
        emit();
        return;
      }
      emit();
      // Tool points are in unrotated page user space; the engine works in MuPDF page space.
      const pageRect = transformRect(page.pageToView, rect);
      void erase(ctx, page, pageRect)
        .catch((error) => ctx.ui.toast(errorText(error)))
        .finally(() => {
          box = null;
          emit();
        });
    },
  };
}

export default definePlugin({
  id: 'erase',
  name: 'Remove logo or stamp',
  version: '1.0.0',
  activate(ctx) {
    const stop = () => {
      if (ctx.tools.active() === ERASE_TOOL) ctx.tools.activate(null);
      box = null;
      emit();
    };
    const disposers = [
      ctx.commands.register({
        id: 'erase.area',
        title: 'Remove logo or stamp',
        icon: Eraser,
        enabled: () => !!ctx.documents.active(),
        run: () => {
          const active = ctx.tools.active() === ERASE_TOOL;
          if (active) {
            stop();
            ctx.ui.toast('Remove logo or stamp is off.');
            return;
          }
          if (useApp.getState().mode !== 'Edit') useApp.getState().set({ mode: 'Edit' });
          ctx.tools.activate(ERASE_TOOL);
          ctx.ui.toast('Drag a box around the logo or stamp. Press Escape to stop.');
        },
      }),
      ctx.toolbar.addItem('Edit', { id: 'erase.area', command: 'erase.area', label: 'Remove logo or stamp' }),
      ctx.tools.register(eraseTool(ctx)),
      useApp.subscribe((state, previous) => {
        if (state.mode !== previous.mode || state.activeId !== previous.activeId) stop();
      }),
    ];
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) stop();
    };
    window.addEventListener('keydown', onKey);
    disposers.push(() => window.removeEventListener('keydown', onKey));
    return () => disposers.forEach((dispose) => dispose());
  },
});
