/** Comments panel (left sidebar), annotation Inspector and tool options (right). */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  Circle,
  Cloud,
  Highlighter,
  Minus,
  MoveUpRight,
  PenLine,
  Pentagon,
  Signature,
  Spline,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Waves,
} from 'lucide-react';
import type { SelectionItem } from '../../plugin-host/types';
import { activeTab, useApp } from '../../store';
import { EmptyState, Slider } from '../../ui';
import type { AnnotPatch, AnnotSummary, LineEnding, RGB } from '../../../engine/tools/annots/types';
import { labelFor } from './shared/AnnotLayer';
import {
  deleteAnnotations,
  findItem,
  flattenAnnotations,
  replyToAnnotation,
  select,
  updateAnnotation,
  useAnnots,
  type AnnotRef,
} from './shared/store';
import { fromHex, SWATCHES, toCss, toHex, toolForType, useTools, type CommentTool } from './toolstate';

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  Highlight: Highlighter,
  Underline: Underline,
  StrikeOut: Strikethrough,
  Squiggly: Waves,
  Text: StickyNote,
  FreeText: Type,
  Square: Square,
  Circle: Circle,
  Line: Minus,
  PolyLine: Spline,
  Polygon: Pentagon,
  Ink: PenLine,
  Stamp: Stamp,
};
function iconFor(a: AnnotSummary) {
  if (a.fillSign === 'signature' || a.fillSign === 'initials') return Signature;
  if (a.type === 'Line' && a.lineEndings && a.lineEndings.end !== 'None') return MoveUpRight;
  if (a.type === 'Polygon' && a.borderEffect === 'Cloudy') return Cloud;
  return ICONS[a.type] ?? StickyNote;
}
const when = (ms?: number) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

function jumpTo(a: AnnotSummary) {
  const tab = activeTab();
  if (!tab) return;
  if (tab.page !== a.pageIndex) useApp.getState().updateTab(tab.info.docId, { page: a.pageIndex });
  let tries = 0;
  const reveal = () => {
    const el = document.querySelector(`[data-annot-id="${a.id}"]`);
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    else if (tries++ < 20) requestAnimationFrame(reveal);
  };
  requestAnimationFrame(reveal);
}

export function CommentsPanel() {
  const items = useAnnots((s) => s.items);
  const selected = useAnnots((s) => s.selected);
  const [type, setType] = useState('all');
  const [author, setAuthor] = useState('all');
  const roots = useMemo(() => items.filter((a) => a.irt === undefined && !a.fillSign), [items]);
  const types = [...new Set(roots.map(labelFor))].sort();
  const authors = [...new Set(roots.map((a) => a.author || ''))].sort();
  const shown = roots.filter(
    (a) => (type === 'all' || labelFor(a) === type) && (author === 'all' || (a.author || '') === author),
  );
  const groups = new Map<number, AnnotSummary[]>();
  for (const a of [...shown].sort((x, y) => x.pageIndex - y.pageIndex || x.bounds[1] - y.bounds[1] || x.bounds[0] - y.bounds[0]))
    groups.set(a.pageIndex, [...(groups.get(a.pageIndex) || []), a]);
  return (
    <div className="comments-panel" data-testid="comments-panel">
      <div className="comments-filters">
        <select aria-label="Filter comments by type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select aria-label="Filter comments by author" value={author} onChange={(e) => setAuthor(e.target.value)}>
          <option value="all">All authors</option>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a || 'No author'}
            </option>
          ))}
        </select>
      </div>
      <div className="comments-count muted">
        {shown.length === roots.length ? `${roots.length} ${roots.length === 1 ? 'comment' : 'comments'}` : `${shown.length} of ${roots.length} comments`}
      </div>
      {!roots.length && <EmptyState>No comments yet. Pick a tool in the toolbar to add one.</EmptyState>}
      {[...groups.entries()].map(([index, list]) => (
        <section key={index} className="comments-page">
          <h3>Page {index + 1}</h3>
          {list.map((a) => (
            <CommentRow key={`${a.pageId}:${a.id}`} item={a} active={!!selected && selected.id === a.id && selected.pageId === a.pageId} replies={items.filter((r) => r.irt === a.id && r.pageId === a.pageId)} />
          ))}
        </section>
      ))}
    </div>
  );
}

function CommentRow({ item, active, replies }: { item: AnnotSummary; active: boolean; replies: AnnotSummary[] }) {
  const Icon = iconFor(item);
  const ref: AnnotRef = { pageId: item.pageId, id: item.id };
  const [text, setText] = useState(item.contents);
  const [reply, setReply] = useState('');
  useEffect(() => setText(item.contents), [item.contents]);
  return (
    <div className={`comment-row ${active ? 'active' : ''}`} data-testid="comment-row">
      <button
        className="comment-head"
        aria-expanded={active}
        onClick={() => {
          select(active ? null : ref, { inspector: !active });
          if (!active) jumpTo(item);
        }}
      >
        <span className="comment-swatch" style={{ color: toCss(item.color ?? item.textColor ?? [0.4, 0.4, 0.4]) }}>
          <Icon size={14} />
        </span>
        <span className="comment-meta">
          <span className="comment-title">
            {labelFor(item)}
            {item.author ? <span className="muted"> · {item.author}</span> : null}
          </span>
          {!active && item.contents && (
            <span className="comment-text" dir="auto">
              {item.contents}
            </span>
          )}
          {!active && replies.length > 0 && (
            <span className="muted comment-replies">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </span>
      </button>
      {active && (
        <div className="comment-body">
          <div className="muted comment-date">{when(item.modified ?? item.created)}</div>
          <textarea
            aria-label="Comment text"
            dir="auto"
            value={text}
            placeholder="Add a comment"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text !== item.contents) void updateAnnotation(ref, { contents: text }, 'Edit comment');
            }}
          />
          {replies.map((r) => (
            <div key={r.id} className="comment-reply">
              <div>
                <strong>{r.author || 'Reply'}</strong> <span className="muted">{when(r.created)}</span>
              </div>
              <p dir="auto">{r.contents}</p>
            </div>
          ))}
          <form
            className="comment-reply-form"
            onSubmit={(e) => {
              e.preventDefault();
              const value = reply.trim();
              if (!value) return;
              setReply('');
              void replyToAnnotation(ref, value);
            }}
          >
            <input aria-label="Reply to comment" dir="auto" placeholder="Reply" value={reply} onChange={(e) => setReply(e.target.value)} />
            <button type="submit" disabled={!reply.trim()}>
              Reply
            </button>
          </form>
          <div className="comment-actions">
            <button onClick={() => void deleteAnnotations([ref])}>
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Debounced patch queue: one engine step per pause in editing. */
function usePatchQueue(ref: AnnotRef | null) {
  const pending = useRef<AnnotPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const target = useRef(ref);
  const flush = () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (target.current && Object.keys(patch).length) void updateAnnotation(target.current, patch, 'Change comment properties');
  };
  useEffect(() => {
    if (target.current && (target.current.id !== ref?.id || target.current.pageId !== ref?.pageId)) flush();
    target.current = ref;
  });
  useEffect(() => () => flush(), []);
  return {
    queue(patch: AnnotPatch, delay = 350) {
      pending.current = { ...pending.current, ...patch };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    flush,
  };
}

function Swatches({ value, onChange, allowNone, label }: { value: RGB | null; onChange: (c: RGB | null) => void; allowNone?: boolean; label: string }) {
  return (
    <div className="annot-swatches" role="group" aria-label={label}>
      {allowNone && (
        <button className={`swatch none ${value ? '' : 'selected'}`} aria-label={`${label}: none`} title="None" onClick={() => onChange(null)} />
      )}
      {SWATCHES.map((c) => (
        <button
          key={c.join()}
          className={`swatch ${value && toHex(value) === toHex(c) ? 'selected' : ''}`}
          style={{ background: toCss(c) }}
          aria-label={`${label} ${toHex(c)}`}
          title={toHex(c)}
          onClick={() => onChange(c)}
        />
      ))}
      <input type="color" aria-label={`${label}: custom`} value={toHex(value)} onChange={(e) => onChange(fromHex(e.target.value))} />
    </div>
  );
}

const FILLABLE = new Set(['Square', 'Circle', 'Polygon', 'FreeText']);
const BORDERED = new Set(['Square', 'Circle', 'Line', 'PolyLine', 'Polygon', 'Ink', 'FreeText']);
const DASHABLE = new Set(['Square', 'Circle', 'Line', 'PolyLine', 'Polygon']);
const ENDINGS: LineEnding[] = ['None', 'OpenArrow', 'ClosedArrow', 'Circle', 'Square', 'Diamond', 'Butt', 'Slash'];

export function AnnotationInspector({ selection }: { selection: SelectionItem[] }) {
  const first = selection[0]?.data as AnnotSummary | undefined;
  const items = useAnnots((s) => s.items);
  const item = first ? (items.find((a) => a.id === first.id && a.pageId === first.pageId) ?? first) : undefined;
  const ref = item ? { pageId: item.pageId, id: item.id } : null;
  const queue = usePatchQueue(ref);
  const [contents, setContents] = useState(item?.contents ?? '');
  const [author, setAuthor] = useState(item?.author ?? '');
  const [opacity, setOpacity] = useState(item?.opacity ?? 1);
  useEffect(() => {
    setContents(item?.contents ?? '');
    setAuthor(item?.author ?? '');
    setOpacity(item?.opacity ?? 1);
  }, [item?.id, item?.contents, item?.author, item?.opacity]);
  if (!item || !ref) return null;
  const tool = toolForType(item.type, {
    arrow: !!item.lineEndings && item.lineEndings.end !== 'None',
    cloud: item.borderEffect === 'Cloudy',
    callout: !!item.callout?.length,
  });
  const remember = (patch: Parameters<ReturnType<typeof useTools.getState>['setStyle']>[1]) => {
    if (tool && !item.fillSign) useTools.getState().setStyle(tool, patch);
  };
  const isText = item.type === 'FreeText';
  const typewriter = isText && item.intent === 'FreeTextTypeWriter';
  return (
    <div className="annot-inspector" data-testid="annot-inspector">
      <div className="annot-inspector-title">
        <strong>{labelFor(item)}</strong>
        <span className="muted">Page {item.pageIndex + 1}</span>
      </div>
      {!(isText && typewriter) && item.type !== 'Stamp' && (
        <label className="annot-field">
          <span>{isText ? 'Border' : 'Colour'}</span>
          <Swatches
            label={isText ? 'Border colour' : 'Colour'}
            value={item.color}
            allowNone={isText}
            onChange={(c) => {
              queue.queue({ color: c }, 0);
              if (c) remember({ color: c });
            }}
          />
        </label>
      )}
      {item.type === 'Stamp' && !item.fillSign && item.intent !== 'StampImage' && (
        <label className="annot-field">
          <span>Colour</span>
          <Swatches label="Stamp colour" value={item.color} onChange={(c) => queue.queue({ color: c }, 0)} />
        </label>
      )}
      {isText && (
        <>
          <label className="annot-field">
            <span>Text colour</span>
            <Swatches
              label="Text colour"
              value={item.textColor ?? [0, 0, 0]}
              onChange={(c) => {
                if (c) {
                  queue.queue({ textColor: c }, 0);
                  remember({ color: c });
                }
              }}
            />
          </label>
          <label className="annot-field inline">
            <span>Font size</span>
            <input
              type="number"
              min={4}
              max={144}
              aria-label="Font size"
              defaultValue={item.fontSize || 12}
              key={`fs-${item.id}-${item.fontSize}`}
              onChange={(e) => {
                const size = Number(e.target.value);
                if (size >= 4 && size <= 144) {
                  queue.queue({ fontSize: size });
                  remember({ fontSize: size });
                }
              }}
            />
          </label>
        </>
      )}
      {FILLABLE.has(item.type) && !typewriter && (
        <label className="annot-field">
          <span>Fill</span>
          <Swatches
            label="Fill colour"
            value={isText ? item.color : item.interiorColor}
            allowNone
            onChange={(c) => {
              if (isText) queue.queue({ color: c }, 0);
              else queue.queue({ interiorColor: c }, 0);
              remember({ fill: c });
            }}
          />
        </label>
      )}
      <label className="annot-field">
        <span>Opacity {Math.round(opacity * 100)}%</span>
        <Slider
          aria-label="Opacity"
          min={10}
          max={100}
          step={5}
          value={Math.round(opacity * 100)}
          onChange={(e) => {
            const value = Number(e.target.value) / 100;
            setOpacity(value);
            queue.queue({ opacity: value }, 450);
          }}
        />
      </label>
      {BORDERED.has(item.type) && !typewriter && (
        <label className="annot-field inline">
          <span>Line width</span>
          <input
            type="number"
            min={0}
            max={24}
            step={0.5}
            aria-label="Line width"
            defaultValue={item.borderWidth ?? 1}
            key={`bw-${item.id}-${item.borderWidth}`}
            onChange={(e) => {
              const width = Number(e.target.value);
              if (width >= 0 && width <= 24) {
                queue.queue({ borderWidth: width });
                remember({ width });
              }
            }}
          />
        </label>
      )}
      {DASHABLE.has(item.type) && (
        <div className="annot-field inline">
          <span>Line style</span>
          <div className="segmented" role="group" aria-label="Line style">
            {(['Solid', 'Dashed'] as const).map((style) => (
              <button
                key={style}
                aria-pressed={(item.borderStyle === 'Dashed') === (style === 'Dashed')}
                onClick={() => {
                  queue.queue({ borderStyle: style }, 0);
                  remember({ dashed: style === 'Dashed' });
                }}
              >
                {style}
              </button>
            ))}
          </div>
        </div>
      )}
      {(item.type === 'Square' || item.type === 'Circle' || item.type === 'Polygon') && (
        <label className="annot-check">
          <input
            type="checkbox"
            checked={item.borderEffect === 'Cloudy'}
            onChange={(e) => queue.queue({ borderEffect: e.target.checked ? 'Cloudy' : 'None' }, 0)}
          />
          Cloudy border
        </label>
      )}
      {(item.type === 'Line' || item.type === 'PolyLine') && (
        <div className="annot-field inline two">
          <span>Ends</span>
          {(['start', 'end'] as const).map((side) => (
            <select
              key={side}
              aria-label={side === 'start' ? 'Line start' : 'Line end'}
              value={item.lineEndings?.[side] ?? 'None'}
              onChange={(e) =>
                queue.queue(
                  {
                    lineEndings: {
                      start: side === 'start' ? (e.target.value as LineEnding) : (item.lineEndings?.start ?? 'None'),
                      end: side === 'end' ? (e.target.value as LineEnding) : (item.lineEndings?.end ?? 'None'),
                    },
                  },
                  0,
                )
              }
            >
              {ENDINGS.map((ending) => (
                <option key={ending} value={ending}>
                  {ending.replace(/([a-z])([A-Z])/g, '$1 $2')}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
      <label className="annot-field">
        <span>{isText ? 'Text' : 'Comment'}</span>
        <textarea
          aria-label={isText ? 'Text box text' : 'Comment text'}
          dir="auto"
          value={contents}
          onChange={(e) => setContents(e.target.value)}
          onBlur={() => {
            if (contents !== item.contents) void updateAnnotation(ref, { contents }, 'Edit comment');
          }}
        />
      </label>
      <label className="annot-field">
        <span>Author</span>
        <input
          aria-label="Author"
          value={author}
          dir="auto"
          onChange={(e) => setAuthor(e.target.value)}
          onBlur={() => {
            if (author !== item.author) void updateAnnotation(ref, { author }, 'Change comment author');
          }}
        />
      </label>
      <div className="annot-inspector-actions">
        <button onClick={() => void deleteAnnotations([ref])}>
          <Trash2 size={14} />
          Delete
        </button>
        <button
          onClick={async () => {
            if (await confirmFlatten('this comment')) void flattenAnnotations('selected', [ref]);
          }}
        >
          Flatten
        </button>
      </div>
      <p className="muted annot-dates">
        {item.created ? `Created ${when(item.created)}` : ''}
        {item.modified && item.modified !== item.created ? ` · Changed ${when(item.modified)}` : ''}
      </p>
    </div>
  );
}

let confirmImpl: (message: string) => Promise<boolean> = async () => true;
export function setConfirm(fn: (message: string) => Promise<boolean>) {
  confirmImpl = fn;
}
export function confirmFlatten(what: string) {
  return confirmImpl(
    `Flatten ${what} into the page? It becomes part of the page content and can no longer be edited as a comment. You can undo this.`,
  );
}

/** Tool options in the Inspector while a creation tool is active and nothing is selected. */
export function ToolOptions() {
  const mode = useApp((s) => s.mode);
  const tool = useTools((s) => s.tool);
  const style = useTools((s) => s.styles[s.tool]);
  const selected = useAnnots((s) => s.selected);
  if (mode !== 'Comment' || tool === 'select' || tool === 'stamp' || findItem(selected)) return null;
  const set = (patch: Parameters<ReturnType<typeof useTools.getState>['setStyle']>[1]) =>
    useTools.getState().setStyle(tool as CommentTool, patch);
  const shape = ['rect', 'ellipse', 'line', 'arrow', 'polyline', 'polygon', 'cloud', 'ink', 'callout'].includes(tool);
  return (
    <div className="annot-inspector" data-testid="tool-options">
      <div className="annot-inspector-title">
        <strong>Tool options</strong>
      </div>
      <label className="annot-field">
        <span>{tool === 'textbox' ? 'Text colour' : 'Colour'}</span>
        <Swatches label="Tool colour" value={style.color} onChange={(c) => c && set({ color: c })} />
      </label>
      {['rect', 'ellipse', 'polygon', 'cloud', 'callout'].includes(tool) && (
        <label className="annot-field">
          <span>Fill</span>
          <Swatches label="Tool fill" value={style.fill} allowNone onChange={(c) => set({ fill: c })} />
        </label>
      )}
      {shape && (
        <label className="annot-field inline">
          <span>Line width</span>
          <input type="number" aria-label="Tool line width" min={0.5} max={24} step={0.5} value={style.width} onChange={(e) => set({ width: Number(e.target.value) || 1 })} />
        </label>
      )}
      {(tool === 'textbox' || tool === 'callout') && (
        <label className="annot-field inline">
          <span>Font size</span>
          <input type="number" aria-label="Tool font size" min={4} max={144} value={style.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) || 12 })} />
        </label>
      )}
      <label className="annot-field">
        <span>Opacity {Math.round(style.opacity * 100)}%</span>
        <Slider aria-label="Tool opacity" min={10} max={100} step={5} value={Math.round(style.opacity * 100)} onChange={(e) => set({ opacity: Number(e.target.value) / 100 })} />
      </label>
    </div>
  );
}
