/** Keyboard handling for a selected annotation (Delete, arrows, Enter, Escape) in one mode. */
import type { AnnotSummary } from './store';
import { deleteAnnotations, findItem, transformAnnotations, useAnnots } from './store';
import { isMovable } from './AnnotLayer';
import { dialogOpen } from './ui-root';

const stop = (e: KeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

export function installAnnotKeys(options: {
  active: () => boolean;
  allow: (a: AnnotSummary) => boolean;
  /** Called on Escape when nothing is selected; return true when handled. */
  onEscape?: () => boolean;
}): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!options.active() || e.defaultPrevented || e.isComposing) return;
    if (dialogOpen() || document.querySelector('[role=dialog]')) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const state = useAnnots.getState();
    if (e.key === 'Escape') {
      if (state.selected || state.textSelection || state.popup || state.draft) {
        state.set({ selected: null, textSelection: null, popup: null, editing: null });
        stop(e);
      } else if (options.onEscape?.()) stop(e);
      return;
    }
    const item = findItem(state.selected);
    if (!item || !options.allow(item)) return;
    const ref = { pageId: item.pageId, id: item.id };
    if (e.key === 'Delete' || e.key === 'Backspace') {
      stop(e);
      void deleteAnnotations([ref]);
      return;
    }
    if (e.key === 'Enter') {
      if (item.type === 'FreeText') state.set({ editing: ref });
      else if (item.type === 'Text') state.set({ popup: ref });
      else return;
      stop(e);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (d && isMovable(item)) {
      stop(e);
      void transformAnnotations([ref], [1, 0, 0, 1, d[0], d[1]], 'Move comment');
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
