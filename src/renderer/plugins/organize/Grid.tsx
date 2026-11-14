/**
 * The Organize grid: page thumbnails with multi-select, drag-and-drop reordering, file drops,
 * keyboard control and a context menu. It is shown over the viewer while the Organize mode is on.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  FileOutput,
  FilePlus2,
  RotateCcw,
  RotateCw,
  Scissors,
  Square,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { PageId, PageInfo } from '../../../shared/engine-api';
import { ContextMenu, Slider } from '../../ui';
import { useApp, type Tab } from '../../store';
import {
  copyPages,
  cutPages,
  deletePages,
  duplicatePages,
  insertBlankAt,
  movePages,
  openInView,
  pastePages,
  rotatePages,
} from './commands';
import { copyPagesTo, insertFiles, notify, pageClipboard, pageContext, plural, readDroppedFiles, tabByDocId } from './pageActions';
import { requestTool } from './requests';
import { MAX_THUMB, MIN_THUMB, selectedInOrder, useOrganize, type DocSelection } from './state';
import { bucketFor, cachedThumb, renderThumb, thumbBox, thumbKey } from './thumbs';

export const PAGE_MIME = 'application/x-garnet-pages';
const GAP = 18;
const TILE_PAD = 8;
const EMPTY: DocSelection = { ids: [] };

/** The pages being dragged (dataTransfer contents are unreadable during dragover). */
let dragging: { docId: string; ids: PageId[] } | null = null;
export function draggedPages() {
  return dragging;
}

interface DropMark {
  index: number;
  x: number;
  y: number;
  h: number;
}

function Tile({
  docId,
  page,
  fingerprint,
  selected,
  focused,
  width,
  bucket,
  root,
}: {
  docId: string;
  page: PageInfo;
  fingerprint: string | undefined;
  selected: boolean;
  focused: boolean;
  width: number;
  bucket: number;
  root: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const painted = useRef('');
  const box = thumbBox(width);
  const fit = Math.min(box.w / page.width, box.h / page.height);
  useEffect(() => {
    if (!fingerprint || !ref.current) return;
    const key = thumbKey(docId, fingerprint, bucket);
    if (painted.current === key) return;
    const draw = (bitmap: ImageBitmap) => {
      const c = canvas.current;
      if (!c) return;
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext('2d')?.drawImage(bitmap, 0, 0);
      c.dataset.painted = 'true';
      painted.current = key;
    };
    const hit = cachedThumb(key);
    if (hit) {
      draw(hit);
      return;
    }
    const abort = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void renderThumb(docId, page.id, page, bucket, key, abort.signal)
          .then((bitmap) => {
            if (bitmap && !abort.signal.aborted) draw(bitmap);
          })
          .catch(() => {});
      },
      { root, rootMargin: '400px 0px' },
    );
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      abort.abort();
    };
  }, [docId, page, fingerprint, bucket, root]);
  const showLabel = page.label && page.label !== String(page.index + 1);
  return (
    <div
      ref={ref}
      className={`organize-tile${selected ? ' selected' : ''}`}
      role="option"
      aria-selected={selected}
      aria-label={`Page ${page.index + 1}${showLabel ? `, labelled ${page.label}` : ''}`}
      data-page-id={page.id}
      data-index={page.index}
      data-rotation={page.rotation}
      tabIndex={focused ? 0 : -1}
      draggable
      style={{ width: box.w + TILE_PAD * 2 }}
    >
      <div className="organize-thumb" style={{ height: box.h }}>
        <div className="organize-paper" style={{ width: Math.round(page.width * fit), height: Math.round(page.height * fit) }}>
          <canvas ref={canvas} />
        </div>
        <div className="organize-tile-actions">
          <button type="button" tabIndex={-1} data-action="rotate-left" aria-label="Rotate counterclockwise" title="Rotate counterclockwise">
            <RotateCcw size={14} />
          </button>
          <button type="button" tabIndex={-1} data-action="rotate-right" aria-label="Rotate clockwise" title="Rotate clockwise">
            <RotateCw size={14} />
          </button>
          <button type="button" tabIndex={-1} data-action="delete" aria-label="Delete page" title="Delete page">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="organize-caption">
        <span>{page.index + 1}</span>
        {showLabel && <span className="organize-label">{page.label}</span>}
      </div>
    </div>
  );
}
const MemoTile = memo(Tile);

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function OrganizeGrid({ tab }: { tab: Tab }) {
  const docId = tab.info.docId;
  const pages = tab.info.pages;
  const selection = useOrganize((s) => s.selection[docId]) ?? EMPTY;
  const width = useOrganize((s) => s.thumbWidth);
  const fingerprints = useOrganize((s) => s.fingerprints[docId]);
  const renders = useOrganize((s) => s.renders);
  const lastOpMs = useOrganize((s) => s.lastOpMs);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const [mark, setMark] = useState<DropMark | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; at: number } | null>(null);
  const bucket = bucketFor(width, window.devicePixelRatio || 1);
  const chosen = useMemo(() => new Set(selection.ids), [selection.ids]);
  const focusId = selection.focus ?? pages[tab.page]?.id;
  const selected = selectedInOrder(docId, pages);

  useEffect(() => {
    let live = true;
    void pageContext()
      .engine.call('pages.fingerprints', { docId, pageIds: pages.map((p) => p.id) }, { priority: 150 })
      .then((values) => {
        if (live) useOrganize.getState().setFingerprints(docId, values);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Page ids and content change only with a new revision.
  }, [docId, tab.info.revision]);

  useEffect(() => {
    // Keyboard control starts on the current page as soon as the grid opens.
    const el = grid.current?.querySelector<HTMLElement>(`[data-page-id="${focusId}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'center' });
  }, [docId]);

  useLayoutEffect(() => {
    if (useOrganize.getState().pendingSince !== null) requestAnimationFrame(() => useOrganize.getState().finishTiming());
  }, [pages]);

  useEffect(() => {
    // After a toolbar command, keyboard control (Delete, arrows, Ctrl+Z) stays on the pages.
    const active = document.activeElement as HTMLElement | null;
    if (document.querySelector('[role=dialog]') || active?.closest('.organize-grid')) return;
    if (active && active !== document.body && !active.closest('.context-toolbar')) return;
    grid.current?.querySelector<HTMLElement>(`[data-page-id="${focusId}"]`)?.focus({ preventScroll: true });
  }, [pages, focusId]);

  useEffect(() => {
    if (!scroller) return;
    const measure = () => {
      const tiles = grid.current?.children;
      if (!tiles || !tiles.length) return;
      const top = (tiles[0] as HTMLElement).offsetTop;
      let n = 0;
      while (n < tiles.length && (tiles[n] as HTMLElement).offsetTop === top) n++;
      setColumns(Math.max(1, n));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, width, pages.length]);

  const select = (patch: DocSelection) => useOrganize.getState().select(docId, patch);
  const indexOf = (id: PageId | undefined) => (id === undefined ? -1 : pages.findIndex((p) => p.id === id));
  const focusTile = (id: PageId) => {
    const el = grid.current?.querySelector<HTMLElement>(`[data-page-id="${id}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  };
  const goTo = (index: number) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, index));
    useApp.getState().updateTab(docId, { page: clamped });
    return pages[clamped];
  };

  const tileOf = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-page-id]') ?? null;
  const pageOf = (el: HTMLElement | null) => (el ? pages.find((p) => p.id === Number(el.dataset.pageId)) : undefined);

  const onClick = (e: MouseEvent) => {
    const tile = tileOf(e.target);
    const page = pageOf(tile);
    if (!page) {
      if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('organize-grid')) select({ ids: [] });
      return;
    }
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action) {
      e.stopPropagation();
      if (action === 'rotate-left') void rotatePages(-90, [page.id]);
      else if (action === 'rotate-right') void rotatePages(90, [page.id]);
      else if (action === 'delete') void deletePages([page.id]);
      return;
    }
    goTo(page.index);
    if (e.shiftKey) {
      const anchor = indexOf(selection.anchor) >= 0 ? indexOf(selection.anchor) : page.index;
      const [a, b] = anchor < page.index ? [anchor, page.index] : [page.index, anchor];
      const range = pages.slice(a, b + 1).map((p) => p.id);
      const ids = e.ctrlKey || e.metaKey ? [...new Set([...selection.ids, ...range])] : range;
      select({ ids, anchor: pages[anchor].id, focus: page.id });
    } else if (e.ctrlKey || e.metaKey) {
      const ids = chosen.has(page.id) ? selection.ids.filter((id) => id !== page.id) : [...selection.ids, page.id];
      select({ ids, anchor: page.id, focus: page.id });
    } else select({ ids: [page.id], anchor: page.id, focus: page.id });
    tile?.focus({ preventScroll: true });
  };

  const onDoubleClick = (e: MouseEvent) => {
    const page = pageOf(tileOf(e.target));
    if (page && !(e.target as HTMLElement).closest('[data-action]')) openInView(docId, page.index);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const page = pageOf(tileOf(e.target));
    if (page) {
      if (!chosen.has(page.id)) select({ ids: [page.id], anchor: page.id, focus: page.id });
      goTo(page.index);
      setMenu({ x: e.clientX, y: Math.min(e.clientY, window.innerHeight - 360), at: page.index + 1 });
    } else setMenu({ x: e.clientX, y: Math.min(e.clientY, window.innerHeight - 360), at: pages.length });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const current = Math.max(0, indexOf(focusId));
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    if (key in step || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') {
      handled();
      const rows = Math.max(1, Math.floor((scroller?.clientHeight ?? 600) / (thumbBox(width).h + 40)));
      const delta = key in step ? step[key] : key === 'PageUp' ? -columns * rows : key === 'PageDown' ? columns * rows : 0;
      if (e.altKey && key in step) {
        const ids = selected.length ? selected : [pages[current].id];
        const indices = ids.map(indexOf);
        const first = Math.min(...indices), last = Math.max(...indices);
        const before = delta < 0 ? Math.max(0, first + delta) : Math.min(pages.length, last + 1 + delta);
        void movePages(docId, ids, before).then(() => focusTile(ids[0]));
        return;
      }
      const target = key === 'Home' ? 0 : key === 'End' ? pages.length - 1 : Math.max(0, Math.min(pages.length - 1, current + delta));
      const page = goTo(target);
      if (e.shiftKey) {
        const anchor = indexOf(selection.anchor) >= 0 ? indexOf(selection.anchor) : current;
        const [a, b] = anchor < target ? [anchor, target] : [target, anchor];
        select({ ids: pages.slice(a, b + 1).map((p) => p.id), anchor: pages[anchor].id, focus: page.id });
      } else if (ctrl) select({ ...selection, focus: page.id });
      else select({ ids: [page.id], anchor: page.id, focus: page.id });
      focusTile(page.id);
      return;
    }
    if (key === ' ' && !ctrl) {
      handled();
      const id = pages[current].id;
      select({ ids: chosen.has(id) ? selection.ids.filter((x) => x !== id) : [...selection.ids, id], anchor: id, focus: id });
      return;
    }
    if (ctrl && key.toLowerCase() === 'a') {
      handled();
      select({ ids: pages.map((p) => p.id), anchor: pages[0].id, focus: focusId });
      return;
    }
    if (key === 'Escape' && selection.ids.length) {
      handled();
      select({ ids: [], focus: focusId });
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && !ctrl) {
      handled();
      void deletePages(selected.length ? selected : [pages[current].id]);
      return;
    }
    if (key === 'Enter') {
      handled();
      openInView(docId, current);
      return;
    }
    if (ctrl && !e.altKey) {
      const ids = selected.length ? selected : [pages[current].id];
      const commands: Record<string, () => Promise<unknown>> = {
        c: () => copyPages(ids),
        x: () => cutPages(ids),
        v: () => pastePages(),
        d: () => duplicatePages(ids),
        r: () => rotatePages(e.shiftKey ? -90 : 90, ids),
      };
      const run = commands[key.toLowerCase()];
      if (run) {
        handled();
        void run();
      }
    }
  };

  const dropAt = (clientX: number, clientY: number): DropMark => {
    const container = grid.current;
    const tiles = container ? Array.from(container.querySelectorAll<HTMLElement>('[data-index]')) : [];
    if (!container || !tiles.length) return { index: 0, x: 0, y: 0, h: 60 };
    const r = container.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    let best = tiles[0], score = Infinity;
    for (const t of tiles) {
      const cx = t.offsetLeft + t.offsetWidth / 2, cy = t.offsetTop + t.offsetHeight / 2;
      const dy = Math.max(0, Math.abs(py - cy) - t.offsetHeight / 2 - GAP / 2);
      const s = dy * 10000 + Math.abs(px - cx);
      if (s < score) {
        score = s;
        best = t;
      }
    }
    const index = Number(best.dataset.index);
    const after = px > best.offsetLeft + best.offsetWidth / 2;
    return {
      index: after ? index + 1 : index,
      x: after ? best.offsetLeft + best.offsetWidth + GAP / 2 : best.offsetLeft - GAP / 2,
      y: best.offsetTop,
      h: best.offsetHeight,
    };
  };

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(PAGE_MIME) || e.dataTransfer.types.includes('Files');
  const onDragStart = (e: DragEvent) => {
    const page = pageOf(tileOf(e.target));
    if (!page) return;
    let ids = selected;
    if (!chosen.has(page.id)) {
      ids = [page.id];
      select({ ids, anchor: page.id, focus: page.id });
    }
    dragging = { docId, ids };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(PAGE_MIME, JSON.stringify(dragging));
    if (ids.length > 1) {
      const ghost = document.createElement('div');
      ghost.className = 'organize-drag-ghost';
      ghost.textContent = plural(ids.length, 'page');
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      setTimeout(() => ghost.remove(), 0);
    }
  };
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dragging?.docId === docId ? 'move' : 'copy';
    const next = dropAt(e.clientX, e.clientY);
    setMark((m) => (m && m.index === next.index && m.x === next.x && m.y === next.y ? m : next));
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (e.clientY < r.top + 48) scroller.scrollBy(0, -16);
      else if (e.clientY > r.bottom - 48) scroller.scrollBy(0, 16);
    }
  };
  const onDragLeave = (e: DragEvent) => {
    if (!scroller || !(e.relatedTarget instanceof Node) || !scroller.contains(e.relatedTarget)) setMark(null);
  };
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const at = mark?.index ?? dropAt(e.clientX, e.clientY).index;
    setMark(null);
    const files = Array.from(e.dataTransfer.files);
    const payload = e.dataTransfer.types.includes(PAGE_MIME) ? dragging : null;
    dragging = null;
    if (payload) {
      if (payload.docId === docId) void movePages(docId, payload.ids, at);
      else void copyPagesTo(payload.docId, payload.ids, docId, at).then((n) => n && notify(`Copied ${plural(n, 'page')}.`));
      return;
    }
    if (files.length) void readDroppedFiles(files).then((list) => insertFiles(docId, at, list));
  };

  // Dropping pages on another document's tab copies them to the end of that document.
  useEffect(() => {
    const tabAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('.document-tab') ?? null;
    const docFor = (el: HTMLElement) => {
      const index = Array.from(document.querySelectorAll('.document-tab')).indexOf(el);
      return useApp.getState().tabs[index]?.info.docId;
    };
    const clear = () => document.querySelectorAll('.organize-tab-target').forEach((el) => el.classList.remove('organize-tab-target'));
    const over = (e: globalThis.DragEvent) => {
      const el = tabAt(e.target);
      if (!el || !dragging || !e.dataTransfer?.types.includes(PAGE_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = docFor(el);
      e.dataTransfer.dropEffect = target && target !== dragging.docId ? 'copy' : 'none';
      if (target && target !== dragging.docId) el.classList.add('organize-tab-target');
    };
    const leave = (e: globalThis.DragEvent) => {
      const el = tabAt(e.target);
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) el.classList.remove('organize-tab-target');
    };
    const drop = (e: globalThis.DragEvent) => {
      const el = tabAt(e.target);
      if (!el || !dragging || !e.dataTransfer?.types.includes(PAGE_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      const payload = dragging;
      dragging = null;
      const target = docFor(el);
      const targetTab = target ? tabByDocId(target) : undefined;
      if (!targetTab || target === payload.docId) return;
      void copyPagesTo(payload.docId, payload.ids, targetTab.info.docId, targetTab.info.pageCount).then(
        (n) => n && notify(`Copied ${plural(n, 'page')} to the end of ${targetTab.file.name}.`),
      );
    };
    const end = () => {
      dragging = null;
      clear();
      setMark(null);
    };
    document.addEventListener('dragover', over, true);
    document.addEventListener('dragleave', leave, true);
    document.addEventListener('drop', drop, true);
    document.addEventListener('dragend', end, true);
    return () => {
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('dragleave', leave, true);
      document.removeEventListener('drop', drop, true);
      document.removeEventListener('dragend', end, true);
    };
  }, []);

  const menuIds = selected.length ? selected : focusId !== undefined ? [focusId] : [];
  const clip = pageClipboard();
  return (
    <div
      className="organize"
      data-testid="organize-grid"
      data-renders={renders}
      data-last-op-ms={lastOpMs === null ? '' : lastOpMs.toFixed(1)}
      data-columns={columns}
    >
      <div className="organize-bar">
        <span className="organize-count" aria-live="polite">
          {selected.length ? `${plural(selected.length, 'page')} selected of ${pages.length.toLocaleString()}` : plural(pages.length, 'page')}
        </span>
        <span className="organize-hint">Drag to reorder · drop PDFs or images to insert · double-click to open</span>
        <div className="organize-size">
          <ZoomOut size={14} aria-hidden />
          <Slider
            aria-label="Thumbnail size"
            min={MIN_THUMB}
            max={MAX_THUMB}
            step={2}
            value={width}
            onChange={(e) => useOrganize.getState().setThumbWidth(Number(e.target.value))}
          />
          <ZoomIn size={14} aria-hidden />
        </div>
      </div>
      <div
        className="organize-scroll"
        ref={setScroller}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onClick}
      >
        <div
          ref={grid}
          className="organize-grid"
          role="listbox"
          aria-multiselectable="true"
          aria-label={`Pages of ${tab.file.name}`}
          style={{ gridTemplateColumns: `repeat(auto-fill, ${thumbBox(width).w + TILE_PAD * 2}px)`, gap: GAP }}
          onKeyDown={onKeyDown}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
        >
          {pages.map((page) => (
            <MemoTile
              key={page.id}
              docId={docId}
              page={page}
              fingerprint={fingerprints?.[page.id]}
              selected={chosen.has(page.id)}
              focused={page.id === focusId}
              width={width}
              bucket={bucket}
              root={scroller}
            />
          ))}
          {mark && <div className="organize-drop-mark" style={{ left: mark.x - 1.5, top: mark.y, height: mark.h }} aria-hidden />}
        </div>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(
            [
              ['Open in View', Eye, 'Enter', () => openInView(docId, Math.max(0, menu.at - 1)), menuIds.length === 1],
              ['Rotate clockwise', RotateCw, 'Ctrl+R', () => rotatePages(90, menuIds), menuIds.length > 0],
              ['Rotate counterclockwise', RotateCcw, 'Ctrl+Shift+R', () => rotatePages(-90, menuIds), menuIds.length > 0],
              ['Duplicate', CopyPlus, 'Ctrl+D', () => duplicatePages(menuIds), menuIds.length > 0],
              ['Copy', Copy, 'Ctrl+C', () => copyPages(menuIds), menuIds.length > 0],
              ['Cut', Scissors, 'Ctrl+X', () => cutPages(menuIds), menuIds.length > 0],
              ['Paste after', ClipboardPaste, 'Ctrl+V', () => pastePages(menu.at), Boolean(clip)],
              ['Insert blank page after', Square, '', () => insertBlankAt(menu.at), true],
              ['Insert pages from file after…', FilePlus2, '', () => requestTool('insert', { at: menu.at }), true],
              ['Extract…', FileOutput, '', () => requestTool('extract'), menuIds.length > 0],
              ['Delete', Trash2, 'Delete', () => deletePages(menuIds), menuIds.length > 0 && menuIds.length < pages.length],
            ] as const
          ).map(([label, Icon, shortcut, run, enabled]) => (
            <button
              key={label}
              role="menuitem"
              disabled={!enabled}
              onClick={() => {
                setMenu(null);
                void run();
              }}
            >
              <Icon size={15} />
              <span>{label}</span>
              {shortcut && <span className="shortcut">{shortcut}</span>}
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}
