import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import type { PluginHost } from './host';
import type { EditPage, Matrix, MenuItem, Point, Rect, SelectionItem } from './types';
import {
  bounds,
  contains,
  identity,
  intersects,
  inverse,
  multiply,
  resizeMatrix,
  rotationMatrix,
  snapMove,
  transformPoint,
  transformRect,
} from './geometry';
import { viewPointToPage, viewDeltaToPage, userHandle } from './geometry';
import { ContextMenu } from '../ui';
interface Gesture {
  start: Point;
  current: Point;
  kind: string;
  selection: SelectionItem[];
  box: Rect;
  matrix: Matrix;
  shift: boolean;
}
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export function EditOverlay({
  host,
  page,
  scale,
  canvas,
}: {
  host: PluginHost;
  page: EditPage;
  scale: number;
  canvas: HTMLCanvasElement | null;
}) {
  const providerVersion = useSyncExternalStore(host.subscribe, host.snapshot);
  const ref = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [candidates, setCandidates] = useState<SelectionItem[]>([]),
    [hover, setHover] = useState<SelectionItem | null>(null),
    [gesture, setGesture] = useState<Gesture | null>(null),
    [guides, setGuides] = useState<{ axis: 'x' | 'y'; value: number }[]>([]),
    [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const selected = host.ctx.selection.get().filter((s) => s.pageId === page.pageId),
    box = selected.length ? bounds(selected.map((s) => s.bounds)) : null;
  const refresh = async () => {
    const all = (
      await Promise.all([...host.providers.values()].map((p) => p.hoverCandidates(page)))
    ).flat();
    setCandidates(all);
    const ids = new Set(host.ctx.selection.get().map((s) => `${s.providerId}:${s.id}`));
    host.ctx.selection.set([
      ...host.ctx.selection.get().filter((s) => s.pageId !== page.pageId),
      ...all.filter((s) => ids.has(`${s.providerId}:${s.id}`)),
    ]);
  };
  useEffect(() => {
    let active = true;
    void Promise.all([...host.providers.values()].map((p) => p.hoverCandidates(page))).then(
      (all) => {
        if (active) setCandidates(all.flat());
      },
    );
    return () => {
      active = false;
    };
  }, [host, page, providerVersion]);
  const point = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect();
    return viewPointToPage(page, [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]);
  };
  const start = async (e: PointerEvent<HTMLDivElement>, kind = 'move') => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Without preventScroll the first click on a page taller than the window scrolled the view to the top of
    // the page, and the click was then read some way below the pointer: the paragraph under a heading opened.
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = point(e);
    let next = selected;
    if (kind === 'move') {
      const hits = (
        await Promise.all([...host.providers.values()].map((p) => p.hitTest(page, pt)))
      ).filter((h): h is NonNullable<typeof h> => Boolean(h));
      // Pressing on an object that is already selected keeps dragging the selection, even when
      // another provider (e.g. text over an image) also reports a hit at this point.
      const alreadySelected = e.shiftKey
        ? undefined
        : hits.find((h) => selected.some((s) => s.id === h.id && s.providerId === h.providerId));
      const hit = alreadySelected ?? hits.at(-1);
      if (hit) {
        if (e.shiftKey) {
          next = selected.some((s) => s.id === hit.id && s.providerId === hit.providerId)
            ? selected.filter(
                (s) =>
                  s !== selected.find((x) => x.id === hit.id && x.providerId === hit.providerId),
              )
            : [...selected, hit];
        } else if (!selected.some((s) => s.id === hit.id && s.providerId === hit.providerId))
          next = [hit];
        host.ctx.selection.set(next);
        await host.providers.get(hit.providerId)?.onActivate?.(
          next.filter((s) => s.providerId === hit.providerId),
          page,
        );
      } else if (!box || !contains(box, pt)) {
        next = e.shiftKey ? selected : [];
        host.ctx.selection.set(next);
        kind = 'rubber';
      }
    }
    const b = next.length
      ? bounds(next.map((s) => s.bounds))
      : ([pt[0], pt[1], pt[0], pt[1]] as Rect);
    if (handles.includes(kind as (typeof handles)[number])) kind = userHandle(page, b, kind);
    setGesture({
      start: pt,
      current: pt,
      kind,
      selection: next,
      box: b,
      matrix: [...identity],
      shift: e.shiftKey,
    });
    if (canvas && preview.current) {
      preview.current.width = canvas.width;
      preview.current.height = canvas.height;
      preview.current.getContext('2d')?.drawImage(canvas, 0, 0);
    }
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const pt = point(e);
    if (!gesture) {
      setHover(candidates.filter((c) => contains(c.bounds, pt)).at(-1) || null);
      return;
    }
    let matrix: Matrix = [...identity];
    if (gesture.kind === 'move') {
      const snapped = snapMove(
        gesture.box,
        [pt[0] - gesture.start[0], pt[1] - gesture.start[1]],
        candidates
          .filter(
            (c) => !gesture.selection.some((s) => s.id === c.id && s.providerId === c.providerId),
          )
          .map((c) => c.bounds),
        [0, 0, page.width, page.height],
        5 / scale,
      );
      matrix = snapped.matrix;
      setGuides(snapped.guides);
    } else if (gesture.kind === 'rotate') {
      matrix = rotationMatrix(gesture.box, gesture.start, pt, e.shiftKey);
    } else if (gesture.kind !== 'rubber') {
      matrix = resizeMatrix(
        gesture.box,
        gesture.kind,
        pt,
        e.shiftKey || gesture.selection.some((s) => s.kind === 'image'),
      );
    }
    setGesture({ ...gesture, current: pt, matrix });
  };
  const apply = async (items: SelectionItem[], matrix: Matrix, label: string) => {
    await host.ctx.history.run(label, async () => {
      for (const provider of host.providers.values()) {
        const own = items.filter((s) => s.providerId === provider.id);
        if (own.length) await provider.onTransform(own, matrix, page);
      }
    });
    await refresh();
  };
  const end = async () => {
    if (!gesture) return;
    const g = gesture;
    setGesture(null);
    setGuides([]);
    if (g.kind === 'rubber') {
      const r: Rect = [
        Math.min(g.start[0], g.current[0]),
        Math.min(g.start[1], g.current[1]),
        Math.max(g.start[0], g.current[0]),
        Math.max(g.start[1], g.current[1]),
      ];
      host.ctx.selection.set([
        ...g.selection,
        ...candidates.filter(
          (c) =>
            intersects(c.bounds, r) &&
            !g.selection.some((s) => s.id === c.id && s.providerId === c.providerId),
        ),
      ]);
    } else if (g.matrix.some((v, i) => Math.abs(v - identity[i]) > 0.0001)) {
      try {
        await apply(
          g.selection,
          g.matrix,
          g.kind === 'move'
            ? 'Move selection'
            : g.kind === 'rotate'
              ? 'Rotate selection'
              : 'Resize selection',
        );
      } catch (error) {
        host.ctx.ui.toast(String(error));
      }
    }
  };
  const visual = (r: Rect) => {
    const v = transformRect(page.pageToView, r);
    return {
      left: v[0] * scale,
      top: v[1] * scale,
      width: (v[2] - v[0]) * scale,
      height: (v[3] - v[1]) * scale,
    };
  };
  const displayBox =
    box && gesture && gesture.kind !== 'rubber' ? transformRect(gesture.matrix, box) : box;
  const previewMatrix = gesture
    ? multiply(page.pageToView, multiply(gesture.matrix, inverse(page.pageToView)))
    : identity;
  const vb = box ? transformRect(page.pageToView, box) : null;
  return (
    <div
      className="edit-overlay"
      data-testid="edit-overlay"
      ref={ref}
      tabIndex={0}
      onPointerDown={(e) => void start(e)}
      onPointerMove={move}
      onPointerUp={() => void end()}
      onPointerCancel={() => {
        setGesture(null);
        setGuides([]);
      }}
      onKeyDown={async (e) => {
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          (e.target as HTMLElement).isContentEditable
        )
          return;
        if (e.key === 'Escape') {
          setGesture(null);
          host.ctx.selection.set([]);
        }
        if (!selected.length) return;
        if (['Delete', 'Backspace'].includes(e.key)) {
          e.preventDefault();
          await host.ctx.history.run('Delete selection', async () => {
            for (const p of host.providers.values()) {
              const own = selected.filter((s) => s.providerId === p.id);
              if (own.length) await p.onDelete?.(own, page);
            }
          });
          host.ctx.selection.set([]);
          await refresh();
        } else if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          e.stopPropagation();
          const n = e.shiftKey ? 10 : 1;
          const delta = viewDeltaToPage(page, [
            e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0,
            e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0,
          ]);
          await apply(selected, [1, 0, 0, 1, delta[0], delta[1]], 'Nudge selection');
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [...host.providers.values()].flatMap(
            (p) =>
              p.contextMenu?.(
                selected.filter((s) => s.providerId === p.id),
                page,
              ) || [],
          ),
        });
      }}
    >
      {[...host.providers.values()].map((p) =>
        p.overlay ? <p.overlay key={p.id} page={page} /> : null,
      )}
      <canvas
        ref={preview}
        className="edit-preview"
        style={{
          display: gesture && gesture.kind !== 'rubber' ? 'block' : 'none',
          width: canvas?.style.width || '100%',
          height: canvas?.style.height || '100%',
          clipPath: vb
            ? `inset(${vb[1] * scale}px calc(100% - ${vb[2] * scale}px) calc(100% - ${vb[3] * scale}px) ${vb[0] * scale}px)`
            : 'none',
          transformOrigin: '0 0',
          transform: `matrix(${previewMatrix[0]},${previewMatrix[1]},${previewMatrix[2]},${previewMatrix[3]},${previewMatrix[4] * scale},${previewMatrix[5] * scale})`,
        }}
      />
      {hover && !gesture && <div className="hover-outline" style={visual(hover.bounds)} />}
      {selected.map((s) => (
        <div
          key={`${s.providerId}:${s.id}`}
          className="item-outline"
          style={visual(gesture ? transformRect(gesture.matrix, s.bounds) : s.bounds)}
        />
      ))}
      {displayBox && (
        <div className="selection-frame" data-testid="selection-frame" style={visual(displayBox)}>
          {handles.map((h) => (
            <div
              key={h}
              role="button"
              aria-label={`Resize ${h}`}
              data-handle={h}
              className={`resize-handle ${h}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                void start(e, h);
              }}
            />
          ))}
          <div
            role="button"
            aria-label="Rotate selection"
            className="rotate-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              void start(e, 'rotate');
            }}
          />
        </div>
      )}
      {gesture?.kind === 'rubber' && (
        <div
          className="rubber-band"
          style={visual([
            Math.min(gesture.start[0], gesture.current[0]),
            Math.min(gesture.start[1], gesture.current[1]),
            Math.max(gesture.start[0], gesture.current[0]),
            Math.max(gesture.start[1], gesture.current[1]),
          ])}
        />
      )}
      {guides.map((g, i) => {
        const a = transformPoint(page.pageToView, g.axis === 'x' ? [g.value, 0] : [0, g.value]),
          b = transformPoint(
            page.pageToView,
            g.axis === 'x' ? [g.value, page.height] : [page.width, g.value],
          );
        return (
          <svg key={i} className="smart-guides" data-testid="smart-guide">
            <line x1={a[0] * scale} y1={a[1] * scale} x2={b[0] * scale} y2={b[1] * scale} />
          </svg>
        );
      })}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.items.length ? (
            menu.items.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                onClick={() => {
                  void item.run();
                  setMenu(null);
                }}
              >
                {item.label}
              </button>
            ))
          ) : (
            <span className="muted">No actions for this selection</span>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
