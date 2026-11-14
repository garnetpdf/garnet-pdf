import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { EditPage, Matrix, Point, Rect, SelectionItem } from '../../plugin-host/types';
import { Button, ContextMenu } from '../../ui';
import {
  resizeMatrix,
  userHandle,
  viewDeltaToPage,
  viewPointToPage,
} from '../../plugin-host/geometry';
import { ObjectsController } from './controller';
import { hitObject, inverse, multiply, transformRect } from './geometry';
import { ObjectActions } from './inspector';
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export function ObjectOverlay({
  controller: c,
  page,
}: {
  controller: ObjectsController;
  page: EditPage;
}) {
  useSyncExternalStore(c.subscribe, c.snapshot);
  const ref = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<SelectionItem[]>([]),
    [hover, setHover] = useState<SelectionItem | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const crop =
    c.crop?.page.docId === page.docId && c.crop?.page.pageId === page.pageId ? c.crop : null;
  useEffect(() => {
    let active = true;
    void c
      .items(page)
      .then((items) => {
        if (active) setItems(items);
      })
      .catch((e) => c.ctx.ui.toast(String(e)));
    return () => {
      active = false;
    };
  }, [c, page, c.contentVersion]);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ratio = () =>
      el.getBoundingClientRect().width /
      ((page.viewRotation ?? 0) % 180 === 0
        ? page.rotation % 180
          ? page.height
          : page.width
        : page.rotation % 180
          ? page.width
          : page.height);
    const observer = new ResizeObserver(() => setScale(ratio()));
    observer.observe(el);
    setScale(ratio());
    return () => observer.disconnect();
  }, [page]);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    el.classList.toggle('objects-crop-active', !!crop);
    if (crop) el.focus();
    return () => el.classList.remove('objects-crop-active');
  }, [crop]);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const pt = (e: { clientX: number; clientY: number }): Point => {
      const r = el.getBoundingClientRect();
      return viewPointToPage(page, [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]);
    };
    let nudge: {
      items: SelectionItem[];
      dx: number;
      dy: number;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let stretch: {
      items: SelectionItem[];
      box: Rect;
      handle: string;
      matrix: Matrix;
      aspect: boolean;
    } | null = null;
    const resetPreview = () => {
      const canvas = el.querySelector<HTMLCanvasElement>('.edit-preview');
      if (canvas) {
        canvas.style.display = 'none';
        canvas.style.transform = '';
      }
    };
    const flush = () => {
      if (!nudge) return;
      const n = nudge;
      nudge = null;
      clearTimeout(n.timer);
      c.ctx.selection.set(n.items);
      void c.run(() => c.transform(n.items, [1, 0, 0, 1, n.dx, n.dy], page));
    };
    const cancel = () => {
      if (nudge) {
        clearTimeout(nudge.timer);
        c.ctx.selection.set(nudge.items);
        nudge = null;
      }
      if (stretch) {
        c.ctx.selection.set(stretch.items);
        stretch = null;
        resetPreview();
      }
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
      if (
        c.crop?.page.docId === page.docId &&
        c.crop?.page.pageId === page.pageId &&
        ['Enter', 'Escape'].includes(e.key)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Enter') void c.run(() => c.applyCrop());
        else c.cancelCrop();
        return;
      }
      if (c.crop?.page.docId === page.docId && c.crop?.page.pageId === page.pageId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const selected = c.own().filter((s) => s.pageId === page.pageId);
      if (
        nudge &&
        (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'))
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
        return;
      }
      if (nudge && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') flush();
      if (
        !e.key.startsWith('Arrow') ||
        !selected.length ||
        selected.length !== c.ctx.selection.get().length
      )
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const reason = c.reason('move', selected);
      if (reason) {
        c.ctx.ui.toast(reason);
        return;
      }
      const n = e.shiftKey ? 10 : 1,
        delta = viewDeltaToPage(page, [
          e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0,
          e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0,
        ]);
      if (!nudge) nudge = { items: selected, dx: 0, dy: 0, timer: setTimeout(flush, 600) };
      clearTimeout(nudge.timer);
      nudge.dx += delta[0];
      nudge.dy += delta[1];
      nudge.timer = setTimeout(flush, 600);
      c.ctx.selection.set(
        nudge.items.map((item) => ({
          ...item,
          bounds: transformRect([1, 0, 0, 1, nudge!.dx, nudge!.dy], item.bounds),
        })),
      );
    };
    const down = (e: PointerEvent) => {
      c.alt = e.altKey;
      if (nudge) {
        e.preventDefault();
        e.stopImmediatePropagation();
        flush();
        return;
      }
      if (
        c.crop?.page.docId === page.docId &&
        c.crop?.page.pageId === page.pageId &&
        !(e.target as HTMLElement).closest('[data-crop-control]')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const selected = c.own().filter((s) => s.pageId === page.pageId);
      const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset
        .handle;
      if (handle && selected.length && c.reason('move', selected)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        c.ctx.ui.toast(c.reason('move', selected)!);
        return;
      }
      // Supply the image aspect toggle using the existing host frame and preview canvas.
      if (handle && selected.length > 0 && selected.length === c.ctx.selection.get().length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        el.focus();
        el.setPointerCapture(e.pointerId);
        const box: Rect = [
          Math.min(...selected.map((s) => s.bounds[0])),
          Math.min(...selected.map((s) => s.bounds[1])),
          Math.max(...selected.map((s) => s.bounds[2])),
          Math.max(...selected.map((s) => s.bounds[3])),
        ];
        stretch = {
          items: selected,
          box,
          handle: userHandle(page, box, handle),
          aspect: selected.some((s) => s.kind === 'image' || s.kind === 'inline-image')
            ? !e.shiftKey
            : e.shiftKey,
          matrix: [1, 0, 0, 1, 0, 0],
        };
        const base = el.parentElement?.querySelector<HTMLCanvasElement>(
            '[data-testid=page-canvas]',
          ),
          preview = el.querySelector<HTMLCanvasElement>('.edit-preview');
        if (base && preview) {
          preview.width = base.width;
          preview.height = base.height;
          preview.getContext('2d')?.drawImage(base, 0, 0);
        }
      }
    };
    const move = (e: PointerEvent) => {
      c.alt = e.altKey;
      if (stretch) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stretch.matrix = resizeMatrix(stretch.box, stretch.handle, pt(e), stretch.aspect);
        c.ctx.selection.set(
          stretch.items.map((item) => ({
            ...item,
            bounds: transformRect(stretch!.matrix, item.bounds),
          })),
        );
        const preview = el.querySelector<HTMLCanvasElement>('.edit-preview');
        if (preview) {
          const m = multiply(page.pageToView, multiply(stretch.matrix, inverse(page.pageToView)));
          const b = transformRect(page.pageToView, stretch.box);
          preview.style.display = 'block';
          preview.style.transformOrigin = '0 0';
          preview.style.clipPath = `inset(${b[1] * scale}px calc(100% - ${b[2] * scale}px) calc(100% - ${b[3] * scale}px) ${b[0] * scale}px)`;
          preview.style.transform = `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4] * scale},${m[5] * scale})`;
        }
      } else if (!e.buttons) setHover(hitObject(itemsRef.current, pt(e), page, scale, e.altKey));
    };
    const up = (e: PointerEvent) => {
      if (!stretch) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = stretch;
      stretch = null;
      resetPreview();
      c.ctx.selection.set(s.items);
      void c.run(() => c.transform(s.items, s.matrix, page));
    };
    const context = (e: MouseEvent) => {
      const selected = c.own().filter((s) => s.pageId === page.pageId);
      if (!selected.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    const drag = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const drop = (e: DragEvent) => {
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) =>
        /^image\/(png|jpeg)$/.test(f.type),
      );
      if (!file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const position = pt(e);
      void c.run(async () => c.add(await file.arrayBuffer(), position, page));
    };
    const blur = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node)) flush();
    };
    el.addEventListener('focusout', blur, true);
    el.addEventListener('keydown', key, true);
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', up, true);
    el.addEventListener('pointercancel', cancel, true);
    el.addEventListener('contextmenu', context, true);
    el.addEventListener('dragover', drag, true);
    el.addEventListener('drop', drop, true);
    return () => {
      cancel();
      el.removeEventListener('focusout', blur, true);
      el.removeEventListener('keydown', key, true);
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', move, true);
      el.removeEventListener('pointerup', up, true);
      el.removeEventListener('pointercancel', cancel, true);
      el.removeEventListener('contextmenu', context, true);
      el.removeEventListener('dragover', drag, true);
      el.removeEventListener('drop', drop, true);
    };
  }, [c, page, scale]);
  const cropDrag = useRef<{ handle: string; rect: Rect; start: Point } | null>(null);
  const style = (rect: Rect) => {
    const b = transformRect(page.pageToView, rect);
    return {
      left: b[0] * scale,
      top: b[1] * scale,
      width: (b[2] - b[0]) * scale,
      height: (b[3] - b[1]) * scale,
    };
  };
  const imageItems = items.filter((item) => item.kind === 'image');
  return (
    <div ref={ref} style={{ pointerEvents: 'none' }}>
      {imageItems.map((item) => (
        <div
          key={item.id}
          data-testid="object-target"
          data-object-kind={item.kind}
          style={{ position: 'absolute', ...style(item.bounds), pointerEvents: 'none' }}
        />
      ))}
      {hover && !crop && <div className="hover-outline" style={style(hover.bounds)} />}
      {crop && (
        <>
          <div
            className="objects-crop"
            data-testid="crop-frame"
            style={style(crop.rect)}
            data-crop-control
            onPointerMove={(e) => {
              const drag = cropDrag.current;
              if (!drag) return;
              e.stopPropagation();
              const overlay = ref.current!.parentElement!,
                r = overlay.getBoundingClientRect(),
                current = viewPointToPage(page, [
                  (e.clientX - r.left) / scale,
                  (e.clientY - r.top) / scale,
                ]);
              const dx = current[0] - drag.start[0],
                dy = current[1] - drag.start[1],
                b = crop.item.bounds,
                next = [...drag.rect] as Rect;
              if (drag.handle.includes('w'))
                next[0] = Math.max(b[0], Math.min(next[2] - 1, drag.rect[0] + dx));
              if (drag.handle.includes('e'))
                next[2] = Math.min(b[2], Math.max(next[0] + 1, drag.rect[2] + dx));
              if (drag.handle.includes('n'))
                next[1] = Math.max(b[1], Math.min(next[3] - 1, drag.rect[1] + dy));
              if (drag.handle.includes('s'))
                next[3] = Math.min(b[3], Math.max(next[1] + 1, drag.rect[3] + dy));
              crop.rect = next;
              c.emit();
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              cropDrag.current = null;
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {handles.map((handle) => (
              <Button
                key={handle}
                className={`objects-crop-handle ${handle}`}
                aria-label={`Crop ${handle}`}
                data-crop-control
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.focus();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const r = ref.current!.parentElement!.getBoundingClientRect();
                  cropDrag.current = {
                    handle: userHandle(page, crop.rect, handle),
                    rect: [...crop.rect],
                    start: viewPointToPage(page, [
                      (e.clientX - r.left) / scale,
                      (e.clientY - r.top) / scale,
                    ]),
                  };
                }}
              />
            ))}
          </div>
          <div
            className="objects-crop-toolbar"
            data-crop-control
            style={{
              left: style(crop.item.bounds).left,
              top: Math.max(0, style(crop.item.bounds).top - 38),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Button onClick={() => void c.run(() => c.applyCrop())}>Apply crop</Button>
            <Button onClick={() => c.cancelCrop()}>Cancel crop</Button>
          </div>
        </>
      )}
      {menu &&
        createPortal(
          <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
            <div onClick={() => setMenu(null)}>
              <ObjectActions controller={c} compact />
            </div>
          </ContextMenu>,
          document.body,
        )}
    </div>
  );
}
