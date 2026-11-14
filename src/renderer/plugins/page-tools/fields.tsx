/** Form pieces shared by the page tool dialogs. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PageId } from '../../../shared/engine-api';
import { formatPageRange, parsePageRange, rangeError } from '../../../engine/pages/range';
import type { Tab } from '../../store';
import { Button } from '../../ui';
import { selectedInOrder } from '../organize/state';
import { pageContext, plural } from '../organize/pageActions';

export function Row({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="pt-row">
      <label className="pt-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="pt-control">
        {children}
        {hint && <div className="pt-hint">{hint}</div>}
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="pt-section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

export function Footer({
  busy,
  disabled,
  action,
  onAction,
  onCancel,
  extra,
  progress,
}: {
  busy: boolean;
  disabled?: boolean;
  action: string;
  onAction: () => void;
  onCancel: () => void;
  extra?: ReactNode;
  progress?: string;
}) {
  return (
    <footer className="pt-footer">
      <div className="pt-footer-start">
        {extra}
        {busy && <span className="pt-progress" role="status">{progress || 'Working…'}</span>}
      </div>
      <Button type="button" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" className="primary" disabled={busy || disabled} onClick={onAction}>
        {action}
      </Button>
    </footer>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="pt-error" role="alert">
      {children}
    </p>
  );
}

export type ScopeMode = 'all' | 'selected' | 'current' | 'range';

/** "Pages" chooser: all, selected, current page, or a typed range. */
export function usePageScope(tab: Tab, options: { preferred?: ScopeMode; label?: string; allowAll?: boolean } = {}) {
  const pages = tab.info.pages;
  const count = pages.length;
  const selected = useMemo(() => selectedInOrder(tab.info.docId, pages), [tab.info.docId, pages]);
  const allowAll = options.allowAll ?? true;
  const [mode, setMode] = useState<ScopeMode>(
    options.preferred ?? (selected.length > 1 ? 'selected' : allowAll ? 'all' : 'current'),
  );
  const [range, setRange] = useState(() => {
    const indices = selected.map((id) => pages.findIndex((p) => p.id === id)).filter((i) => i >= 0);
    return indices.length ? formatPageRange(indices) : `1-${count}`;
  });
  let ids: PageId[] = [];
  let error: string | null = null;
  if (mode === 'all') ids = pages.map((p) => p.id);
  else if (mode === 'selected') ids = selected;
  else if (mode === 'current') ids = pages[tab.page] ? [pages[tab.page].id] : [];
  else {
    error = rangeError(range, count);
    if (!error) ids = parsePageRange(range, count).map((i) => pages[i].id);
  }
  if (!error && !ids.length) error = 'Choose at least one page.';
  const name = useRef(`scope-${Math.random().toString(36).slice(2)}`).current;
  const element = (
    <fieldset className="pt-scope">
      <legend>{options.label ?? 'Pages'}</legend>
      {allowAll && (
        <label>
          <input type="radio" name={name} checked={mode === 'all'} onChange={() => setMode('all')} />
          All pages ({count.toLocaleString()})
        </label>
      )}
      <label className={selected.length ? '' : 'pt-disabled'}>
        <input type="radio" name={name} disabled={!selected.length} checked={mode === 'selected'} onChange={() => setMode('selected')} />
        Selected {selected.length ? `(${plural(selected.length, 'page')})` : '(none)'}
      </label>
      <label>
        <input type="radio" name={name} checked={mode === 'current'} onChange={() => setMode('current')} />
        Current page ({tab.page + 1})
      </label>
      <label className="pt-scope-range">
        <input type="radio" name={name} checked={mode === 'range'} onChange={() => setMode('range')} />
        Range
        <input
          aria-label="Page range"
          value={range}
          placeholder="1-3, 7, 10-"
          onFocus={() => setMode('range')}
          onChange={(e) => {
            setRange(e.target.value);
            setMode('range');
          }}
          aria-invalid={mode === 'range' && Boolean(error)}
        />
      </label>
      {mode === 'range' && error && <span className="pt-error">{error}</span>}
    </fieldset>
  );
  return { ids, error, element, mode, indices: ids.map((id) => pages.findIndex((p) => p.id === id)) };
}

export type Unit = 'mm' | 'in' | 'pt';
const UNIT_KEY = 'garnet.units';
export const UNIT_FACTOR: Record<Unit, number> = { pt: 1, mm: 72 / 25.4, in: 72 };
export function storedUnit(): Unit {
  try {
    const value = localStorage.getItem(UNIT_KEY);
    if (value === 'mm' || value === 'in' || value === 'pt') return value;
  } catch {
    /* Default below. */
  }
  return 'mm';
}
export function saveUnit(unit: Unit): void {
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch {
    /* Not persisted. */
  }
}
export function fromPoints(points: number, unit: Unit): number {
  const value = points / UNIT_FACTOR[unit];
  return Math.round(value * (unit === 'pt' ? 1 : unit === 'mm' ? 10 : 100)) / (unit === 'pt' ? 1 : unit === 'mm' ? 10 : 100);
}
export function toPoints(value: number, unit: Unit): number {
  return value * UNIT_FACTOR[unit];
}

export function UnitSelect({ unit, onChange }: { unit: Unit; onChange: (unit: Unit) => void }) {
  return (
    <select
      aria-label="Units"
      className="pt-unit"
      value={unit}
      onChange={(e) => {
        const next = e.target.value as Unit;
        saveUnit(next);
        onChange(next);
      }}
    >
      <option value="mm">mm</option>
      <option value="in">in</option>
      <option value="pt">pt</option>
    </select>
  );
}

/** A length typed in the chosen unit, stored in points. */
export function LengthInput({ label, points, unit, onChange, min = 0, max = 2000 }: { label: string; points: number; unit: Unit; onChange: (points: number) => void; min?: number; max?: number }) {
  const [text, setText] = useState(String(fromPoints(points, unit)));
  const last = useRef({ points, unit });
  useEffect(() => {
    if (last.current.unit !== unit || Math.abs(last.current.points - points) > 0.01) setText(String(fromPoints(points, unit)));
    last.current = { points, unit };
  }, [points, unit]);
  return (
    <label className="pt-length">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={text}
        min={fromPoints(min, unit)}
        max={fromPoints(max, unit)}
        step={unit === 'in' ? 0.05 : unit === 'mm' ? 0.5 : 1}
        onChange={(e) => {
          setText(e.target.value);
          const value = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(value)) {
            const pts = Math.max(min, Math.min(max, toPoints(value, unit)));
            last.current = { points: pts, unit };
            onChange(pts);
          }
        }}
      />
      <span className="pt-unit-label">{unit}</span>
    </label>
  );
}

const mm = (value: number) => Math.round(((value * 72) / 25.4) * 100) / 100;
/** Paper sizes in points: ISO sizes from their exact millimetres, US sizes from inches. */
export const PAPER: Record<string, [number, number]> = {
  A3: [mm(297), mm(420)],
  A4: [mm(210), mm(297)],
  A5: [mm(148), mm(210)],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

/** Draws engine pixels (RGBA) into a canvas. */
export function PixelCanvas({ image, label }: { image: { pixels: Uint8ClampedArray; width: number; height: number } | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !image) return;
    c.width = image.width;
    c.height = image.height;
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  }, [image]);
  return <canvas ref={ref} className="pt-preview-canvas" role="img" aria-label={label} />;
}

/** Renders one page (bitmap) for previews. */
export function usePageImage(docId: string, pageId: PageId | undefined, scale: number, revision: number) {
  const [image, setImage] = useState<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  useEffect(() => {
    if (pageId === undefined) return;
    const abort = new AbortController();
    void pageContext()
      .engine.call('core.render', { docId, pageId, scale, dpr: 1, annots: true, forms: true }, { signal: abort.signal, priority: 90 })
      .then(async (r) => {
        if (abort.signal.aborted) {
          r.bitmap?.close();
          return;
        }
        if (r.pixels) {
          setImage({ pixels: r.pixels, width: r.width, height: r.height });
          return;
        }
        if (!r.bitmap) return;
        const canvas = new OffscreenCanvas(r.width, r.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(r.bitmap, 0, 0);
        r.bitmap.close();
        setImage({ pixels: context.getImageData(0, 0, r.width, r.height).data, width: r.width, height: r.height });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [docId, pageId, scale, revision]);
  return image;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '000000';
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
}
export function rgbToHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
