/** Tool overlays for Comment mode: select / text selection, markup, notes, text, shapes, ink, stamps. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Highlighter, Strikethrough, Underline, Waves } from 'lucide-react';
import type { EditPage, Point } from '../../plugin-host/types';
import type { TextLine } from '../../../shared/engine-api';
import type { AnnotCreateSpec, CreatableType } from '../../../engine/tools/annots/types';
import { selectText } from '../../../engine/tools/annots/selection';
import { AnnotLayer } from './shared/AnnotLayer';
import {
  createAnnotation,
  pageLines,
  select,
  useAnnots,
  type AnnotRef,
} from './shared/store';
import { pageSize, pctRect, rectOf } from './shared/geometry';
import { meanPressure, smoothStroke, type Pt } from './shared/smoothing';
import { toCss, useTools, type CommentTool } from './toolstate';
import { loadStoredImage } from '../fill-sign/store';

export interface ToolApi {
  activate: (tool: CommentTool) => void;
}
let api: ToolApi = { activate: () => {} };
export function setToolApi(next: ToolApi) {
  api = next;
}

const MARKUP_TYPE: Partial<Record<CommentTool, CreatableType>> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'StrikeOut',
  squiggly: 'Squiggly',
};

function quadBox(q: number[]): [number, number, number, number] {
  return rectOf([
    [q[0], q[1]],
    [q[2], q[3]],
    [q[4], q[5]],
    [q[6], q[7]],
  ]);
}

function usePageLines(page: EditPage) {
  const [lines, setLines] = useState<TextLine[]>([]);
  useEffect(() => {
    let alive = true;
    void pageLines(page).then((l) => {
      if (alive) setLines(l);
    });
    return () => {
      alive = false;
    };
  }, [page]);
  return lines;
}

export async function createMarkup(tool: CommentTool, selection: { pageId: number; quads: number[][] }) {
  const type = MARKUP_TYPE[tool];
  if (!type || !selection.quads.length) return null;
  const style = useTools.getState().styles[tool];
  const ref = await createAnnotation(
    selection.pageId,
    { type, quads: selection.quads as AnnotCreateSpec['quads'], color: style.color, opacity: style.opacity },
    { select: false },
  );
  useAnnots.getState().set({ textSelection: null });
  return ref;
}

function copyText(text: string) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function SelectionPreview({ page, color, quads }: { page: EditPage; color: string; quads: number[][] }) {
  return (
    <>
      {quads.map((q, i) => (
        <div key={i} className="annot-text-sel" style={{ ...pctRect(page, quadBox(q)), background: color }} />
      ))}
    </>
  );
}

/** Default Comment tool: select annotations, or drag over text to select it for markup. */
export function SelectOverlay({ page }: { page: EditPage }) {
  const lines = usePageLines(page);
  const start = useRef<Point | null>(null);
  const textSelection = useAnnots((s) => s.textSelection);
  const mineSel = textSelection && textSelection.pageId === page.pageId ? textSelection : null;
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={(a) => !a.fillSign}
      onBackgroundDown={(p) => {
        start.current = p;
        if (useAnnots.getState().textSelection) useAnnots.getState().set({ textSelection: null });
      }}
      onBackgroundMove={(p) => {
        if (!start.current) return;
        const sel = selectText(lines, start.current, p);
        useAnnots.getState().set({ textSelection: sel.count ? { pageId: page.pageId, quads: sel.quads, text: sel.text } : null });
      }}
      onBackgroundUp={() => {
        start.current = null;
      }}
    >
      {mineSel && (
        <>
          <SelectionPreview page={page} color="rgba(40, 118, 237, 0.28)" quads={mineSel.quads} />
          <SelectionBar page={page} quads={mineSel.quads} text={mineSel.text} />
        </>
      )}
    </AnnotLayer>
  );
}

function SelectionBar({ page, quads, text }: { page: EditPage; quads: number[][]; text: string }) {
  const last = quadBox(quads[quads.length - 1]);
  const [, ph] = pageSize(page);
  const below = last[3] + 34 < ph;
  const items: [CommentTool, string, ReactNode][] = [
    ['highlight', 'Highlight text', <Highlighter key="h" size={15} />],
    ['underline', 'Underline text', <Underline key="u" size={15} />],
    ['strike', 'Strike through text', <Strikethrough key="s" size={15} />],
    ['squiggly', 'Squiggly underline', <Waves key="q" size={15} />],
  ];
  return (
    <div
      className="annot-selection-bar"
      role="toolbar"
      aria-label="Selected text"
      style={{ ...pctRect(page, [last[2], below ? last[3] + 4 : last[1] - 34, last[2], below ? last[3] + 4 : last[1] - 34]) }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map(([tool, label, icon]) => (
        <button
          key={tool}
          className="icon-button"
          aria-label={label}
          title={label}
          onClick={() => void createMarkup(tool, { pageId: page.pageId, quads })}
        >
          {icon}
        </button>
      ))}
      <button
        className="icon-button"
        aria-label="Copy text"
        title="Copy text"
        onClick={() => {
          copyText(text);
          useAnnots.getState().set({ textSelection: null });
        }}
      >
        <Copy size={15} />
      </button>
    </div>
  );
}

/** Highlight / underline / strike-through / squiggly: drag over text. */
export function MarkupOverlay({ page, tool }: { page: EditPage; tool: CommentTool }) {
  const lines = usePageLines(page);
  const start = useRef<Point | null>(null);
  const [preview, setPreview] = useState<{ quads: number[][]; area: boolean } | null>(null);
  const style = useTools((s) => s.styles[tool]);
  const compute = (from: Point, to: Point) => {
    const sel = selectText(lines, from, to);
    if (sel.count) return { quads: sel.quads as number[][], area: false };
    // No text under the drag (for example a scan): highlight the dragged area instead.
    if (tool === 'highlight' && Math.abs(to[0] - from[0]) > 4 && Math.abs(to[1] - from[1]) > 4) {
      const r = rectOf([from, to]);
      return { quads: [[r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]], area: true };
    }
    return null;
  };
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onBackgroundDown={(p) => {
        start.current = p;
        setPreview(null);
      }}
      onBackgroundMove={(p) => {
        if (start.current) setPreview(compute(start.current, p));
      }}
      onBackgroundUp={(p) => {
        const from = start.current;
        start.current = null;
        const result = from ? compute(from, p) : null;
        setPreview(null);
        if (result) void createMarkup(tool, { pageId: page.pageId, quads: result.quads });
      }}
    >
      {preview && (
        <SelectionPreview
          page={page}
          color={tool === 'highlight' ? toCss(style.color, 0.45) : toCss(style.color, 0.25)}
          quads={preview.quads}
        />
      )}
    </AnnotLayer>
  );
}

/** Sticky note and text box: click places a draft that is created once text is typed. */
export function ClickDraftOverlay({ page, tool }: { page: EditPage; tool: 'note' | 'textbox' }) {
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onBackgroundUp={(p) => {
        const style = useTools.getState().styles[tool];
        if (tool === 'note')
          useAnnots.getState().set({
            draft: { kind: 'note', pageId: page.pageId, point: [p[0] - 10, p[1] - 10], spec: { color: style.color } },
          });
        else
          useAnnots.getState().set({
            draft: {
              kind: 'freetext',
              pageId: page.pageId,
              point: [p[0], p[1] - style.fontSize * 0.7],
              spec: { intent: 'FreeTextTypeWriter', fontSize: style.fontSize, textColor: style.color, borderWidth: 0 },
            },
          });
        api.activate('select');
      }}
    />
  );
}

/** Callout: press at the point to call out, release where the text box goes. */
export function CalloutOverlay({ page }: { page: EditPage }) {
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const style = useTools((s) => s.styles.callout);
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onBackgroundDown={(p) => setDrag({ from: p, to: p })}
      onBackgroundMove={(p) => setDrag((d) => (d ? { ...d, to: p } : d))}
      onBackgroundUp={(p) => {
        const from = drag?.from ?? p;
        setDrag(null);
        const far = Math.hypot(p[0] - from[0], p[1] - from[1]) > 12;
        const box: Point = far ? p : [from[0] + 50, from[1] - 50];
        useAnnots.getState().set({
          draft: {
            kind: 'freetext',
            pageId: page.pageId,
            point: box,
            spec: {
              intent: 'FreeTextCallout',
              callout: [from],
              fontSize: style.fontSize,
              textColor: [0, 0, 0],
              color: style.fill ?? [1, 1, 1],
              borderWidth: Math.max(0.5, style.width),
            },
          },
        });
        api.activate('select');
      }}
    >
      {drag && (
        <svg className="annot-preview" viewBox={`0 0 ${pageSize(page).join(' ')}`} preserveAspectRatio="none">
          <line x1={drag.from[0]} y1={drag.from[1]} x2={drag.to[0]} y2={drag.to[1]} stroke={toCss(style.color)} strokeWidth={style.width} />
        </svg>
      )}
    </AnnotLayer>
  );
}

const constrain = (from: Point, to: Point, square: boolean): Point => {
  if (!square) return to;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * size, from[1] + Math.sign(dy || 1) * size];
};
const snapAngle = (from: Point, to: Point, snap: boolean): Point => {
  if (!snap) return to;
  const angle = Math.round(Math.atan2(to[1] - from[1], to[0] - from[0]) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length];
};

/** Rectangle, ellipse, line and arrow: drag to draw (Shift keeps squares / 45 degree lines). */
export function ShapeOverlay({ page, tool }: { page: EditPage; tool: 'rect' | 'ellipse' | 'line' | 'arrow' }) {
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const style = useTools((s) => s.styles[tool]);
  const box = tool === 'rect' || tool === 'ellipse';
  const finish = async (from: Point, to: Point) => {
    const s = useTools.getState().styles[tool];
    const common = { color: s.color, borderWidth: s.width, opacity: s.opacity, borderStyle: s.dashed ? ('Dashed' as const) : ('Solid' as const) };
    let ref: AnnotRef | null;
    if (box) {
      const tiny = Math.abs(to[0] - from[0]) < 3 && Math.abs(to[1] - from[1]) < 3;
      const r = tiny ? ([from[0] - 40, from[1] - 25, from[0] + 40, from[1] + 25] as const) : rectOf([from, to]);
      ref = await createAnnotation(page.pageId, {
        type: tool === 'rect' ? 'Square' : 'Circle',
        rect: [...r],
        interiorColor: s.fill,
        ...common,
      });
    } else {
      const end: Point = Math.hypot(to[0] - from[0], to[1] - from[1]) < 3 ? [from[0] + 80, from[1]] : to;
      ref = await createAnnotation(page.pageId, {
        type: 'Line',
        line: [from, end],
        intent: tool === 'arrow' ? 'LineArrow' : undefined,
        lineEndings: tool === 'arrow' ? { start: 'None', end: 'OpenArrow' } : undefined,
        ...common,
      });
    }
    api.activate('select');
    if (ref) select(ref, { inspector: true });
  };
  const [pw, ph] = pageSize(page);
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onBackgroundDown={(p) => setDrag({ from: p, to: p })}
      onBackgroundMove={(p, e) =>
        setDrag((d) => (d ? { ...d, to: box ? constrain(d.from, p, e.shiftKey) : snapAngle(d.from, p, e.shiftKey) } : d))
      }
      onBackgroundUp={() => {
        const d = drag;
        setDrag(null);
        if (d) void finish(d.from, d.to);
      }}
    >
      {drag && (
        <svg className="annot-preview" viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none">
          {tool === 'rect' && (() => {
            const r = rectOf([drag.from, drag.to]);
            return <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} fill={toCss(style.fill)} stroke={toCss(style.color)} strokeWidth={style.width} strokeDasharray={style.dashed ? '4 3' : undefined} />;
          })()}
          {tool === 'ellipse' && (() => {
            const r = rectOf([drag.from, drag.to]);
            return <ellipse cx={(r[0] + r[2]) / 2} cy={(r[1] + r[3]) / 2} rx={(r[2] - r[0]) / 2} ry={(r[3] - r[1]) / 2} fill={toCss(style.fill)} stroke={toCss(style.color)} strokeWidth={style.width} />;
          })()}
          {(tool === 'line' || tool === 'arrow') && (
            <line x1={drag.from[0]} y1={drag.from[1]} x2={drag.to[0]} y2={drag.to[1]} stroke={toCss(style.color)} strokeWidth={style.width} />
          )}
        </svg>
      )}
    </AnnotLayer>
  );
}

/** Polyline, polygon and cloud: click to add points, double-click or Enter to finish, Esc to cancel. */
export function PolyOverlay({ page, tool }: { page: EditPage; tool: 'polyline' | 'polygon' | 'cloud' }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [hover, setHover] = useState<Point | null>(null);
  const style = useTools((s) => s.styles[tool]);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const finish = async (list: Point[]) => {
    const minimum = tool === 'polyline' ? 2 : 3;
    setPoints([]);
    setHover(null);
    if (list.length < minimum) return;
    const s = useTools.getState().styles[tool];
    const ref = await createAnnotation(page.pageId, {
      type: tool === 'polyline' ? 'PolyLine' : 'Polygon',
      vertices: list,
      color: s.color,
      borderWidth: s.width,
      opacity: s.opacity,
      interiorColor: tool === 'polyline' ? undefined : s.fill,
      borderEffect: tool === 'cloud' ? 'Cloudy' : undefined,
      intent: tool === 'cloud' ? 'PolygonCloud' : undefined,
      borderStyle: s.dashed ? 'Dashed' : 'Solid',
    });
    api.activate('select');
    if (ref) select(ref, { inspector: true });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!pointsRef.current.length) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void finish(pointsRef.current);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setPoints([]);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setPoints((p) => p.slice(0, -1));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const [pw, ph] = pageSize(page);
  const shown = hover && points.length ? [...points, hover] : points;
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onBackgroundDown={(p) => {
        const last = pointsRef.current.at(-1);
        if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 2) setPoints((list) => [...list, p]);
      }}
      onHover={(p) => {
        if (pointsRef.current.length) setHover(p);
      }}
      onBackgroundDoubleClick={() => void finish(pointsRef.current)}
    >
      {shown.length > 0 && (
        <svg className="annot-preview" viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none">
          {tool === 'polyline' ? (
            <polyline points={shown.map((p) => p.join(',')).join(' ')} fill="none" stroke={toCss(style.color)} strokeWidth={style.width} />
          ) : (
            <polygon points={shown.map((p) => p.join(',')).join(' ')} fill={toCss(style.fill, 0.5)} stroke={toCss(style.color)} strokeWidth={style.width} strokeDasharray={tool === 'cloud' ? '2 2' : undefined} />
          )}
          {points.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={2} fill="#2873ee" />
          ))}
        </svg>
      )}
      {points.length > 0 && <div className="annot-hint">Double-click or press Enter to finish</div>}
    </AnnotLayer>
  );
}

interface InkStroke {
  points: Pt[];
  pressure: { x: number; y: number; pressure: number; time: number }[];
}

/** Freehand ink: strokes drawn in quick succession become one drawing. */
export function InkOverlay({ page }: { page: EditPage }) {
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [live, setLive] = useState<InkStroke | null>(null);
  const liveRef = useRef<InkStroke | null>(null);
  const strokesRef = useRef<InkStroke[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const style = useTools((s) => s.styles.ink);
  strokesRef.current = strokes;
  const commit = async (list: InkStroke[]) => {
    clearTimeout(timer.current);
    if (!list.length) return;
    setStrokes([]);
    strokesRef.current = [];
    const s = useTools.getState().styles.ink;
    const pen = list.some((k) => k.pressure.some((p) => p.pressure > 0 && Math.abs(p.pressure - 0.5) > 0.01));
    const pressure = meanPressure(list.flatMap((k) => k.pressure));
    const width = pen ? Math.max(0.5, s.width * (0.6 + 0.8 * pressure)) : s.width;
    await createAnnotation(
      page.pageId,
      {
        type: 'Ink',
        ink: list.map((k) => smoothStroke(k.points.length === 1 ? [k.points[0], [k.points[0][0] + 0.5, k.points[0][1] + 0.5]] : k.points)),
        color: s.color,
        borderWidth: width,
        opacity: s.opacity,
      },
      { select: false },
    );
  };
  useEffect(
    () => () => {
      void commit(strokesRef.current);
    },
    [],
  );
  const [pw, ph] = pageSize(page);
  const all = live ? [...strokes, live] : strokes;
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onBackgroundDown={(p, e) => {
        clearTimeout(timer.current);
        const stroke = { points: [p as Pt], pressure: [{ x: p[0], y: p[1], pressure: e.pressure, time: e.timeStamp }] };
        liveRef.current = stroke;
        setLive(stroke);
      }}
      onBackgroundMove={(_p, e, points) => {
        const stroke = liveRef.current;
        if (!stroke) return;
        const next = {
          points: [...stroke.points, ...(points as Pt[])],
          pressure: [...stroke.pressure, ...points.map((q) => ({ x: q[0], y: q[1], pressure: e.pressure, time: e.timeStamp }))],
        };
        liveRef.current = next;
        setLive(next);
      }}
      onBackgroundUp={() => {
        const stroke = liveRef.current;
        liveRef.current = null;
        setLive(null);
        if (!stroke) return;
        const list = [...strokesRef.current, stroke];
        setStrokes(list);
        strokesRef.current = list;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void commit(strokesRef.current), 900);
      }}
    >
      {all.length > 0 && (
        <svg className="annot-preview" viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none">
          {all.map((k, i) => (
            <polyline
              key={i}
              points={k.points.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke={toCss(style.color, style.opacity)}
              strokeWidth={style.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>
      )}
    </AnnotLayer>
  );
}

/** Stamp: click to place the chosen stamp. */
export function StampOverlay({ page }: { page: EditPage }) {
  const stamp = useTools((s) => s.stamp);
  const [hover, setHover] = useState<Point | null>(null);
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onHover={setHover}
      onBackgroundUp={async (p) => {
        let spec: AnnotCreateSpec;
        if (stamp.imageId) {
          const image = await loadStoredImage(stamp.imageId);
          if (!image) return;
          const width = Math.min(160, image.width * 0.5);
          const height = (width * image.height) / image.width;
          spec = { type: 'Stamp', rect: [p[0] - width / 2, p[1] - height / 2, p[0] + width / 2, p[1] + height / 2], image: image.png, contents: stamp.label };
        } else {
          spec = { type: 'Stamp', rect: [p[0] - 75, p[1] - 22, p[0] + 75, p[1] + 22], icon: stamp.icon, color: stamp.color, contents: stamp.label };
        }
        const ref = await createAnnotation(page.pageId, spec);
        api.activate('select');
        if (ref) select(ref, { inspector: true });
      }}
    >
      {hover && (
        <div className="annot-stamp-ghost" style={pctRect(page, [hover[0] - 75, hover[1] - 22, hover[0] + 75, hover[1] + 22])}>
          {stamp.label}
        </div>
      )}
    </AnnotLayer>
  );
}
