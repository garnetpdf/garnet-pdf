/**
 * Interactive annotation layer rendered inside a host tool overlay: hit areas, the Edit-mode-style
 * selection frame (move / resize), in-place text editing for text boxes and sticky-note pop-ups.
 * All geometry is MuPDF page space (P); every committed gesture is one engine call (one undo step).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { MessageSquare, Trash2, X } from 'lucide-react';
import type { EditPage, Point, Rect } from '../../../plugin-host/types';
import { resizeMatrix } from '../../../plugin-host/geometry';
import { useApp } from '../../../store';
import {
  authorName,
  createAnnotation,
  deleteAnnotations,
  findItem,
  notify,
  replyToAnnotation,
  select,
  transformAnnotations,
  updateAnnotation,
  useAnnots,
  type AnnotRef,
  type AnnotSummary,
  type Draft,
} from './store';
import { eventToP, pageSize, pctPoint, pctRect, usePageScale } from './geometry';
import { NEEDS_PICTURE, renderTextBlock } from '../../fill-sign/raster';
import { browserRaster } from '../../fill-sign/browser-raster';

type Matrix = [number, number, number, number, number, number];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
const RESIZABLE = new Set(['Square', 'Circle', 'FreeText', 'Stamp', 'Ink', 'Polygon', 'PolyLine', 'Line']);
export const isMovable = (a: AnnotSummary) => !MARKUP.has(a.type) && !a.locked;
export const isResizable = (a: AnnotSummary) => RESIZABLE.has(a.type) && !a.locked;
export const TEXT_FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

const applyMatrix = (m: Matrix, p: Point): Point => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
function matrixRect(m: Matrix, r: Rect): Rect {
  const a = applyMatrix(m, [r[0], r[1]]);
  const b = applyMatrix(m, [r[2], r[3]]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
const sameRef = (a: AnnotRef | null, b: { pageId: number; id: number } | null | undefined) =>
  !!a && !!b && a.id === b.id && a.pageId === b.pageId;

let measureCanvas: HTMLCanvasElement | null = null;
/** Text box size for MuPDF's FreeText layout (Helvetica metrics; Arial is metric-compatible). */
export function fitText(text: string, fontSize: number, minWidth = 0): [number, number] {
  measureCanvas ??= document.createElement('canvas');
  const context = measureCanvas.getContext('2d');
  const lines = (text || ' ').split('\n');
  let width = minWidth;
  if (context) {
    context.font = `${fontSize}px ${TEXT_FONT}`;
    for (const line of lines) width = Math.max(width, context.measureText(line || ' ').width);
  } else width = Math.max(width, ...lines.map((l) => l.length * fontSize * 0.55));
  return [Math.ceil(width + fontSize * 0.6 + 6), Math.ceil(lines.length * fontSize * 1.18 + fontSize * 0.5 + 4)];
}

interface Gesture {
  kind: 'move' | 'resize';
  handle?: string;
  ref: AnnotRef;
  box: Rect;
  start: Point;
  matrix: Matrix;
  moved: boolean;
  aspect: boolean;
}

export function AnnotLayer({
  page,
  selectable,
  capture = false,
  onBackgroundDown,
  onBackgroundMove,
  onBackgroundUp,
  onHover,
  onBackgroundDoubleClick,
  underlay,
  children,
}: {
  page: EditPage;
  selectable: (a: AnnotSummary) => boolean;
  capture?: boolean;
  onBackgroundDown?: (point: Point, event: ReactPointerEvent) => void;
  /** `points` includes coalesced pointer samples for smooth ink. */
  onBackgroundMove?: (point: Point, event: ReactPointerEvent, points: Point[]) => void;
  onBackgroundUp?: (point: Point, event: ReactPointerEvent) => void;
  onHover?: (point: Point) => void;
  onBackgroundDoubleClick?: (point: Point) => void;
  /** Rendered below the annotation hit areas (for example form fields). */
  underlay?: ReactNode;
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const scale = usePageScale(root, page);
  const items = useAnnots((s) => s.items);
  const selected = useAnnots((s) => s.selected);
  const editing = useAnnots((s) => s.editing);
  const popup = useAnnots((s) => s.popup);
  const draft = useAnnots((s) => s.draft);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const background = useRef(false);
  const hand = useApp((s) => s.hand);
  const mine = items.filter((a) => a.pageId === page.pageId && !a.hidden && selectable(a));
  const current = mine.find((a) => sameRef(selected, a));
  const [pw, ph] = pageSize(page);

  const begin = (e: ReactPointerEvent, item: AnnotSummary, kind: 'move' | 'resize', handle?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const ref = { pageId: item.pageId, id: item.id };
    const wasSelected = sameRef(selected, item);
    select(ref, { inspector: !wasSelected });
    if (kind === 'move' && !isMovable(item)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const g: Gesture = {
      kind,
      handle,
      ref,
      box: item.type === 'Stamp' || item.type === 'FreeText' || item.type === 'Square' || item.type === 'Circle' ? (item.rect ?? item.bounds) : item.bounds,
      start: eventToP(page, e, root.current!),
      matrix: [1, 0, 0, 1, 0, 0],
      moved: false,
      aspect: item.type === 'Stamp',
    };
    gestureRef.current = g;
    setGesture(g);
  };
  const move = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    e.stopPropagation();
    const p = eventToP(page, e, root.current!);
    let matrix: Matrix;
    if (g.kind === 'move') matrix = [1, 0, 0, 1, p[0] - g.start[0], p[1] - g.start[1]];
    else matrix = resizeMatrix(g.box, g.handle!, p, g.aspect || e.shiftKey) as Matrix;
    const moved = g.moved || Math.hypot(p[0] - g.start[0], p[1] - g.start[1]) > 1.5;
    const next = { ...g, matrix, moved };
    gestureRef.current = next;
    setGesture(next);
  };
  const end = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setGesture(null);
    if (!g) return;
    e.stopPropagation();
    if (g.moved)
      void transformAnnotations([g.ref], g.matrix, g.kind === 'move' ? 'Move comment' : 'Resize comment');
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gestureRef.current) {
        gestureRef.current = null;
        setGesture(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  const open = (item: AnnotSummary) => {
    const ref = { pageId: item.pageId, id: item.id };
    if (item.type === 'FreeText') useAnnots.getState().set({ selected: ref, editing: ref });
    else if (item.type === 'Text') useAnnots.getState().set({ selected: ref, popup: ref });
    else select(ref, { inspector: true });
  };

  const frameBox = current
    ? gesture && sameRef(gesture.ref, current)
      ? matrixRect(gesture.matrix, gesture.box)
      : current.bounds
    : null;
  return (
    <div
      ref={root}
      className={`annot-layer ${capture ? 'capture' : ''} ${hand ? 'hand' : ''}`}
      data-testid="annot-layer"
      onPointerDown={(e) => {
        if (!capture || e.button !== 0 || e.target !== e.currentTarget) return;
        e.stopPropagation();
        root.current!.setPointerCapture(e.pointerId);
        background.current = true;
        const state = useAnnots.getState();
        if (state.selected || state.popup || state.editing) state.set({ selected: null, popup: null, editing: null });
        onBackgroundDown?.(eventToP(page, e, root.current!), e);
      }}
      onPointerMove={(e) => {
        if (!capture) return;
        if (!background.current) {
          onHover?.(eventToP(page, e, root.current!));
          return;
        }
        e.stopPropagation();
        const native = e.nativeEvent as PointerEvent;
        const samples = native.getCoalescedEvents?.() ?? [];
        const points = (samples.length ? samples : [native]).map((s) => eventToP(page, s, root.current!));
        onBackgroundMove?.(points[points.length - 1], e, points);
      }}
      onDoubleClick={(e) => {
        if (!capture) return;
        e.stopPropagation();
        onBackgroundDoubleClick?.(eventToP(page, e, root.current!));
      }}
      onPointerUp={(e) => {
        if (!background.current) return;
        background.current = false;
        e.stopPropagation();
        onBackgroundUp?.(eventToP(page, e, root.current!), e);
      }}
    >
      {underlay}
      {mine
        .filter((item) => !strokeHit(item))
        .map((item) => (
          <div
            key={item.id}
            className={`annot-hit ${isMovable(item) ? 'movable' : ''}`}
            data-testid="annot-hit"
            data-annot-type={item.type}
            data-annot-id={item.id}
            style={pctRect(page, padRect(item.bounds, 3))}
            onPointerDown={(e) => begin(e, item, 'move')}
            onPointerMove={move}
            onPointerUp={end}
            onDoubleClick={(e) => {
              e.stopPropagation();
              open(item);
            }}
            title={titleFor(item)}
          />
        ))}
      {mine.some(strokeHit) && (
        <svg className="annot-hit-svg" viewBox={`0 0 ${pw} ${ph}`} preserveAspectRatio="none" aria-hidden="true">
          {mine.filter(strokeHit).map((item) => (
            <g
              key={item.id}
              className={`annot-hit-stroke ${isMovable(item) ? 'movable' : ''}`}
              data-testid="annot-hit"
              data-annot-type={item.type}
              data-annot-id={item.id}
              strokeWidth={Math.max(8, (item.borderWidth ?? 1) + 6)}
              onPointerDown={(e) => begin(e as unknown as ReactPointerEvent, item, 'move')}
              onPointerMove={(e) => move(e as unknown as ReactPointerEvent)}
              onPointerUp={(e) => end(e as unknown as ReactPointerEvent)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                open(item);
              }}
            >
              <title>{titleFor(item)}</title>
              <StrokeShape item={item} />
            </g>
          ))}
        </svg>
      )}
      {current && frameBox && (
        <div
          className={`selection-frame annot-frame ${gesture?.moved ? 'moving' : ''}`}
          data-testid="annot-frame"
          style={pctRect(page, frameBox)}
        >
          {isResizable(current) &&
            !(gesture?.moved && gesture.kind === 'move') &&
            HANDLES.filter((h) => {
              // Keep the middle of small items free for moving and double-clicking.
              if ((h === 'n' || h === 's') && (frameBox[3] - frameBox[1]) * scale < 40) return false;
              if ((h === 'e' || h === 'w') && (frameBox[2] - frameBox[0]) * scale < 40) return false;
              return true;
            }).map((h) => (
              <div
                key={h}
                className={`resize-handle ${h}`}
                data-handle={h}
                onPointerDown={(e) => begin(e, current, 'resize', h)}
                onPointerMove={move}
                onPointerUp={end}
              />
            ))}
        </div>
      )}
      {mine
        .filter((a) => a.type === 'FreeText' && sameRef(editing, a))
        .map((a) => (
          <TextEditor key={`edit-${a.id}`} page={page} scale={scale} item={a} />
        ))}
      {draft && draft.pageId === page.pageId && draft.kind === 'freetext' && (
        <TextEditor page={page} scale={scale} draft={draft} />
      )}
      {mine
        .filter((a) => a.type === 'Text' && sameRef(popup, a))
        .map((a) => (
          <NotePopup key={`note-${a.id}`} page={page} item={a} />
        ))}
      {draft && draft.pageId === page.pageId && draft.kind === 'note' && <NotePopup page={page} draft={draft} />}
      {children}
    </div>
  );
}

/** Unfilled shapes and lines are picked by their outline, so text inside a box stays selectable. */
function strokeHit(a: AnnotSummary): boolean {
  if (a.type === 'Line' || a.type === 'PolyLine' || a.type === 'Ink') return true;
  return (a.type === 'Square' || a.type === 'Circle' || a.type === 'Polygon') && !a.interiorColor;
}

function StrokeShape({ item }: { item: AnnotSummary }) {
  const r = item.rect ?? item.bounds;
  const inset = (item.borderWidth ?? 1) / 2;
  const points = (list: Point[]) => list.map((p) => p.join(',')).join(' ');
  switch (item.type) {
    case 'Square':
      return <rect x={r[0] + inset} y={r[1] + inset} width={Math.max(0, r[2] - r[0] - 2 * inset)} height={Math.max(0, r[3] - r[1] - 2 * inset)} />;
    case 'Circle':
      return <ellipse cx={(r[0] + r[2]) / 2} cy={(r[1] + r[3]) / 2} rx={Math.max(0, (r[2] - r[0]) / 2 - inset)} ry={Math.max(0, (r[3] - r[1]) / 2 - inset)} />;
    case 'Polygon':
      return item.vertices?.length ? <polygon points={points(item.vertices)} /> : <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} />;
    case 'PolyLine':
      return item.vertices?.length ? <polyline points={points(item.vertices)} /> : <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} />;
    case 'Line':
      return item.line ? <line x1={item.line[0][0]} y1={item.line[0][1]} x2={item.line[1][0]} y2={item.line[1][1]} /> : null;
    case 'Ink':
      return <>{(item.ink ?? []).map((stroke, i) => (stroke.length === 1 ? <circle key={i} cx={stroke[0][0]} cy={stroke[0][1]} r={1} /> : <polyline key={i} points={points(stroke)} />))}</>;
    default:
      return null;
  }
}

function padRect(r: Rect, pad: number): Rect {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const px = w < 8 ? pad + (8 - w) / 2 : 0;
  const py = h < 8 ? pad + (8 - h) / 2 : 0;
  return [r[0] - px, r[1] - py, r[2] + px, r[3] + py];
}

export const TYPE_LABELS: Record<string, string> = {
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strike-through',
  Squiggly: 'Squiggly underline',
  Text: 'Sticky note',
  FreeText: 'Text box',
  Square: 'Rectangle',
  Circle: 'Ellipse',
  Line: 'Line',
  PolyLine: 'Polyline',
  Polygon: 'Polygon',
  Ink: 'Drawing',
  Stamp: 'Stamp',
  FileAttachment: 'Attachment',
  Caret: 'Insert text',
  Redact: 'Redaction mark',
};

export function labelFor(a: AnnotSummary): string {
  if (a.fillSign) {
    const names: Record<string, string> = {
      signature: 'Signature',
      initials: 'Initials',
      text: 'Text',
      date: 'Date',
      tick: 'Tick',
      cross: 'Cross',
      dot: 'Dot',
    };
    return names[a.fillSign] ?? 'Fill & Sign item';
  }
  if (a.type === 'Line' && a.lineEndings && a.lineEndings.end !== 'None') return 'Arrow';
  if (a.type === 'Polygon' && a.borderEffect === 'Cloudy') return 'Cloud';
  if (a.type === 'FreeText' && a.callout?.length) return 'Callout';
  return TYPE_LABELS[a.type] ?? a.type;
}

function titleFor(a: AnnotSummary): string {
  const text = a.contents.trim();
  return text ? `${labelFor(a)}: ${text.slice(0, 120)}` : labelFor(a);
}

function TextEditor({
  page,
  scale,
  item,
  draft,
}: {
  page: EditPage;
  scale: number;
  item?: AnnotSummary;
  draft?: Draft;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const fontSize = item?.fontSize || draft?.spec.fontSize || 12;
  const color = item?.textColor ?? draft?.spec.textColor ?? [0, 0, 0];
  const [value, setValue] = useState(item?.contents ?? '');
  const valueRef = useRef(value);
  valueRef.current = value;
  const origin: Point = item ? [item.rect?.[0] ?? item.bounds[0], item.rect?.[1] ?? item.bounds[1]] : draft!.point;
  const minWidth = item?.rect ? item.rect[2] - item.rect[0] - fontSize * 0.6 - 6 : 0;
  const [w, h] = fitText(value, fontSize, Math.max(minWidth, fontSize * 6));
  const height = Math.max(h, item?.rect ? item.rect[3] - item.rect[1] : 0);
  useLayoutEffect(() => {
    ref.current?.focus();
    if (item) ref.current?.select();
  }, [item]);
  const commit = async (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const text = valueRef.current.replace(/\s+$/, '');
    const state = useAnnots.getState();
    if (draft) {
      if (state.draft === draft) state.set({ draft: null });
      if (keep && text && NEEDS_PICTURE.test(text)) {
        await addTextPicture(draft.pageId, origin, text, fontSize, color, draft.spec.fillSign);
        return;
      }
      if (keep && text) {
        const [fw, fh] = fitText(text, fontSize, 0);
        const rect: Rect = [origin[0], origin[1], origin[0] + fw, origin[1] + fh];
        const spec = {
          type: 'FreeText',
          intent: 'FreeTextTypeWriter',
          borderWidth: 0,
          ...draft.spec,
          contents: text,
          rect,
        } as Parameters<typeof createAnnotation>[1];
        if (draft.spec.callout?.length === 1) spec.callout = calloutLine(draft.spec.callout[0], rect);
        await createAnnotation(draft.pageId, spec);
      }
      return;
    }
    if (item) {
      if (sameRef(state.editing, item)) state.set({ editing: null });
      if (!keep || text === item.contents) return;
      if (NEEDS_PICTURE.test(text)) {
        const ref = { pageId: item.pageId, id: item.id };
        if (await addTextPicture(item.pageId, origin, text, fontSize, color, item.fillSign)) await deleteAnnotations([ref]);
        return;
      }
      const r = item.rect ?? item.bounds;
      const [fw, fh] = fitText(text, fontSize, r[2] - r[0] - fontSize * 0.6 - 6);
      const typewriter = item.intent === 'FreeTextTypeWriter';
      const rect: Rect = [r[0], r[1], typewriter ? r[0] + fw : Math.max(r[2], r[0] + Math.min(fw, r[2] - r[0])), Math.max(r[3], r[1] + fh)];
      await updateAnnotation({ pageId: item.pageId, id: item.id }, { contents: text, rect }, 'Edit text box');
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      // Unmounted without a blur (for example by a click that selected something else).
      const typed = valueRef.current.replace(/\s+$/, '');
      if (!done.current && (draft ? typed : typed !== (item?.contents ?? ''))) void commitRef.current(true);
    },
    [],
  );
  return (
    <textarea
      ref={ref}
      className="annot-text-editor"
      data-testid="annot-text-editor"
      aria-label={draft ? 'New text' : 'Edit text'}
      dir="auto"
      value={value}
      spellCheck
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => void commit(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          void commit(true);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void commit(true);
        }
      }}
      style={{
        ...pctRect(page, [origin[0], origin[1], origin[0] + w, origin[1] + height]),
        fontSize: fontSize * scale,
        lineHeight: 1.18,
        color: `rgb(${color.map((c) => Math.round(c * 255)).join(',')})`,
        fontFamily: TEXT_FONT,
        padding: `${2 * scale}px ${3 * scale}px`,
      }}
    />
  );
}

const PICTURE_FONT = 'Arial, Tahoma, "Segoe UI", "Noto Sans Arabic", "Noto Naskh Arabic", sans-serif';
let pictureNoticeShown = false;
/**
 * Text the standard PDF fonts cannot draw (such as Arabic) is added as a high-resolution picture of
 * the text, with the text kept in the annotation contents, so it shows the same in every PDF reader.
 */
async function addTextPicture(
  pageId: number,
  origin: Point,
  text: string,
  fontSize: number,
  color: [number, number, number],
  fillSign?: AnnotSummary['fillSign'],
) {
  try {
    const image = await renderTextBlock(browserRaster, text, { fontSize, color, family: PICTURE_FONT, scale: 4 });
    const ref = await createAnnotation(pageId, {
      type: 'Stamp',
      rect: [origin[0], origin[1], origin[0] + image.pointWidth, origin[1] + image.pointHeight],
      image: image.png,
      contents: text,
      subject: 'Text',
      fillSign,
    });
    if (ref && !pictureNoticeShown) {
      pictureNoticeShown = true;
      notify('This text uses letters the standard PDF fonts cannot show, so it was added as a picture of the text. It looks the same in every PDF reader.');
    }
    return !!ref;
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Callout line [tip, knee, attach] from the called-out point to the nearest side of the text box. */
export function calloutLine(tip: Point, r: Rect): Point[] {
  const sides: [Point, Point][] = [
    [[r[0], (r[1] + r[3]) / 2], [-1, 0]],
    [[r[2], (r[1] + r[3]) / 2], [1, 0]],
    [[(r[0] + r[2]) / 2, r[1]], [0, -1]],
    [[(r[0] + r[2]) / 2, r[3]], [0, 1]],
  ];
  const [attach, normal] = sides.reduce((best, side) =>
    Math.hypot(side[0][0] - tip[0], side[0][1] - tip[1]) < Math.hypot(best[0][0] - tip[0], best[0][1] - tip[1]) ? side : best,
  );
  const knee: Point = [attach[0] + normal[0] * 12, attach[1] + normal[1] * 12];
  return [tip, knee, attach];
}

function formatDate(ms?: number) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function NotePopup({ page, item, draft }: { page: EditPage; item?: AnnotSummary; draft?: Draft }) {
  const items = useAnnots((s) => s.items);
  const [text, setText] = useState(item?.contents ?? '');
  const textRef = useRef(text);
  textRef.current = text;
  const [reply, setReply] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  const author = useApp((s) => s.settings.authorName);
  const replies = item ? items.filter((a) => a.irt === item.id && a.pageId === item.pageId) : [];
  const anchor: Point = item ? [item.bounds[2], item.bounds[1]] : [draft!.point[0] + 20, draft!.point[1]];
  const [pageWidth, pageHeight] = pageSize(page);
  const leftSide = anchor[0] > pageWidth * 0.62;
  const upward = anchor[1] > pageHeight * 0.62;
  useLayoutEffect(() => {
    area.current?.focus();
  }, []);
  const saved = useRef(item?.contents ?? '');
  const saveText = async () => {
    const value = textRef.current;
    if (draft) {
      if (finished.current) return;
      finished.current = true;
      if (useAnnots.getState().draft === draft) useAnnots.getState().set({ draft: null });
      if (value.trim())
        await createAnnotation(draft.pageId, {
          type: 'Text',
          rect: [draft.point[0], draft.point[1], draft.point[0] + 20, draft.point[1] + 20],
          contents: value,
          ...draft.spec,
        } as Parameters<typeof createAnnotation>[1]);
      return;
    }
    if (item && value !== saved.current) {
      saved.current = value;
      await updateAnnotation({ pageId: item.pageId, id: item.id }, { contents: value }, 'Edit note');
    }
  };
  const saveRef = useRef(saveText);
  saveRef.current = saveText;
  useEffect(
    () => () => {
      if (draft ? textRef.current.trim() : textRef.current !== saved.current) void saveRef.current();
    },
    [],
  );
  const close = () => {
    void saveText();
    if (item) useAnnots.getState().set({ popup: null });
  };
  return (
    <div
      ref={box}
      className={`note-popup ${leftSide ? 'left' : ''} ${upward ? 'up' : ''}`}
      data-testid="note-popup"
      role="group"
      aria-label="Sticky note"
      style={pctPoint(page, anchor)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
      }}
      onBlur={(e) => {
        if (draft && !box.current?.contains(e.relatedTarget as Node)) void saveText();
      }}
    >
      <header>
        <MessageSquare size={14} />
        <span className="note-author">{item?.author || author || 'Note'}</span>
        <span className="muted note-date">{formatDate(item?.modified ?? item?.created)}</span>
        {item && (
          <button
            className="icon-button small"
            aria-label="Delete note"
            title="Delete note"
            onClick={() => void deleteAnnotations([{ pageId: item.pageId, id: item.id }])}
          >
            <Trash2 size={13} />
          </button>
        )}
        <button className="icon-button small" aria-label="Close note" title="Close note" onClick={close}>
          <X size={13} />
        </button>
      </header>
      <textarea
        ref={area}
        aria-label="Note text"
        dir="auto"
        value={text}
        placeholder="Add a note"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (item) void saveText();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            close();
          }
        }}
      />
      {item && (
        <>
          {replies.map((r) => (
            <div className="note-reply" key={r.id}>
              <div className="note-reply-head">
                <strong>{r.author || 'Reply'}</strong>
                <span className="muted">{formatDate(r.created)}</span>
              </div>
              <p dir="auto">{r.contents}</p>
            </div>
          ))}
          <form
            className="note-reply-form"
            onSubmit={(e) => {
              e.preventDefault();
              const value = reply.trim();
              if (!value) return;
              setReply('');
              void replyToAnnotation({ pageId: item.pageId, id: item.id }, value);
            }}
          >
            <input
              aria-label="Reply"
              placeholder={authorName() ? `Reply as ${authorName()}` : 'Reply'}
              value={reply}
              dir="auto"
              onChange={(e) => setReply(e.target.value)}
            />
            <button type="submit" disabled={!reply.trim()}>
              Reply
            </button>
          </form>
        </>
      )}
    </div>
  );
}

export function useSelectedItem(): AnnotSummary | undefined {
  const selected = useAnnots((s) => s.selected);
  useAnnots((s) => s.items);
  return findItem(selected);
}
