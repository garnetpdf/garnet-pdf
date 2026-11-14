/** Create a signature or initials by typing, drawing or importing a picture; optionally save it. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Eraser, ImagePlus, Trash2 } from 'lucide-react';
import { useApp } from '../../store';
import type { PressurePoint } from '../comment/shared/smoothing';
import { ARABIC, prepareImage, renderStrokes, renderTyped, type RasterImage, type RGB, type StrokeInput } from './raster';
import { browserRaster, loadSignatureFonts, SIGNATURE_FONTS } from './browser-raster';
import { addSignItem, bytesToBase64, loadSignStore, removeSignItem, useSignStore, type StoredSignItem } from './store';

export type SignKind = 'signature' | 'initials';
type Tab = 'Type' | 'Draw' | 'Image';
const PAD_W = 560;
const PAD_H = 180;
const COLOURS: { label: string; value: RGB }[] = [
  { label: 'Black', value: [0, 0, 0] },
  { label: 'Blue', value: [0.07, 0.2, 0.62] },
];

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 4);
}

const pngUrl = (png: ArrayBuffer) => `data:image/png;base64,${bytesToBase64(png)}`;

export function SignatureDialog({
  kind,
  close,
  onDone,
}: {
  kind: SignKind;
  close: () => void;
  onDone: (item: StoredSignItem) => void;
}) {
  const author = useApp((s) => s.settings.authorName);
  const persistent = useSignStore((s) => s.persistent);
  const loaded = useSignStore((s) => s.loaded);
  const reason = useSignStore((s) => s.reason);
  const [tab, setTab] = useState<Tab>('Type');
  const [name, setName] = useState(() => (kind === 'initials' ? initialsOf(author) : author.trim()));
  const [fontId, setFontId] = useState(() => (ARABIC.test(author) ? 'ruqaa' : 'great-vibes'));
  const [colour, setColour] = useState<RGB>(COLOURS[0].value);
  const [strokes, setStrokes] = useState<StrokeInput[]>([]);
  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null);
  const [preview, setPreview] = useState<RasterImage | null>(null);
  const [removeWhite, setRemoveWhite] = useState(true);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const noun = kind === 'initials' ? 'initials' : 'signature';

  useEffect(() => {
    // The shell dialog focuses its first control after mounting; move focus to the name afterwards.
    const timer = setTimeout(() => nameInput.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    void loadSignStore();
    loadSignatureFonts()
      .then(() => setFontsReady(true))
      .catch(() => setError('The signature fonts could not be loaded. Draw or import a picture instead.'));
  }, []);
  useEffect(() => {
    if (ARABIC.test(name) && fontId !== 'ruqaa') setFontId('ruqaa');
  }, [name, fontId]);
  useEffect(() => {
    if (!imageBytes) {
      setPreview(null);
      return;
    }
    let alive = true;
    prepareImage(browserRaster, imageBytes, { removeWhite })
      .then((result) => alive && setPreview(result))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [imageBytes, removeWhite]);

  const font = SIGNATURE_FONTS.find((f) => f.id === fontId) ?? SIGNATURE_FONTS[0];
  const ready =
    tab === 'Type' ? !!name.trim() && fontsReady : tab === 'Draw' ? strokes.some((s) => s.points.length) : !!preview;

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      let image: RasterImage;
      if (tab === 'Type')
        image = await renderTyped(browserRaster, name, { family: font.family, weight: font.weight, size: 96, color: colour });
      else if (tab === 'Draw')
        image = await renderStrokes(browserRaster, strokes, { width: PAD_W, height: PAD_H, color: colour, penWidth: 2.8, scale: 2 });
      else {
        if (!preview) throw new Error('Choose a picture first.');
        image = preview;
      }
      const label = tab === 'Type' ? name.trim() : kind === 'initials' ? 'Drawn initials' : 'Drawn signature';
      const keep = remember && persistent;
      const result = await addSignItem({ kind, name: tab === 'Image' ? `Picture ${noun}` : label, ...image }, keep);
      if (keep && !result.saved && result.reason) setError(result.reason);
      onDone(result.item);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sign-dialog" data-testid="signature-dialog">
      <div className="segmented sign-tabs" role="tablist" aria-label={`How to create your ${noun}`}>
        {(['Type', 'Draw', 'Image'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            aria-pressed={tab === t}
            onClick={() => {
              setTab(t);
              setError('');
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Type' && (
        <div className="sign-panel" role="tabpanel" aria-label="Type">
          <label className="sign-field">
            <span>{kind === 'initials' ? 'Initials' : 'Your name'}</span>
            <input
              ref={nameInput}
              value={name}
              dir="auto"
              maxLength={80}
              placeholder={kind === 'initials' ? 'For example AL' : 'Type your name'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="sign-fonts" role="radiogroup" aria-label="Style">
            {SIGNATURE_FONTS.map((f) => (
              <button
                key={f.id}
                role="radio"
                aria-checked={fontId === f.id}
                aria-label={f.label}
                className={`sign-font ${fontId === f.id ? 'selected' : ''}`}
                onClick={() => setFontId(f.id)}
                style={{ fontFamily: `"${f.family}"`, fontWeight: Number(f.weight), color: `rgb(${colour.map((c) => Math.round(c * 255)).join(',')})` }}
                dir="auto"
              >
                {name.trim() || f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'Draw' && (
        <div className="sign-panel" role="tabpanel" aria-label="Draw">
          <SignaturePad strokes={strokes} onChange={setStrokes} colour={colour} />
          <div className="sign-row">
            <span className="muted">Draw with a mouse, pen or finger.</span>
            <button onClick={() => setStrokes([])} disabled={!strokes.length}>
              <Eraser size={15} />
              Clear
            </button>
          </div>
        </div>
      )}

      {tab === 'Image' && (
        <div className="sign-panel" role="tabpanel" aria-label="Image">
          <div className="sign-image-box">
            {preview ? (
              <img src={pngUrl(preview.png)} alt={`Imported ${noun}`} data-testid="signature-image-preview" />
            ) : (
              <span className="muted">A photo or scan of your {noun} on white paper works best.</span>
            )}
          </div>
          <div className="sign-row">
            <label className="annot-check">
              <input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} />
              Remove white background
            </label>
            <button onClick={() => file.current?.click()}>
              <ImagePlus size={15} />
              Choose picture
            </button>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg"
              aria-label={`${noun} picture file`}
              hidden
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                if (!picked) return;
                setError('');
                if (picked.size > 15 * 1024 * 1024) {
                  setError('This picture is too large (over 15 MB).');
                  return;
                }
                setImageBytes(await picked.arrayBuffer());
              }}
            />
          </div>
        </div>
      )}

      <div className="sign-row">
        <div className="sign-colours" role="radiogroup" aria-label="Ink colour">
          {tab !== 'Image' &&
            COLOURS.map((c) => (
              <button
                key={c.label}
                role="radio"
                aria-checked={colour === c.value}
                aria-label={c.label}
                title={c.label}
                className={`swatch ${colour === c.value ? 'selected' : ''}`}
                style={{ background: `rgb(${c.value.map((v) => Math.round(v * 255)).join(',')})` }}
                onClick={() => setColour(c.value)}
              />
            ))}
        </div>
        <label className="annot-check">
          <input
            type="checkbox"
            checked={remember && persistent}
            disabled={!persistent}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Save {noun} for next time
        </label>
      </div>
      {loaded && !persistent && <p className="muted sign-note">{reason || 'Saved signatures are not available on this computer.'} It is used for this document only.</p>}
      {error && (
        <p className="annot-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button onClick={close}>Cancel</button>
        <button className="primary" disabled={!ready || busy} onClick={() => void finish()}>
          {busy ? 'Preparing…' : 'Use'}
        </button>
      </footer>
    </div>
  );
}

function SignaturePad({
  strokes,
  onChange,
  colour,
}: {
  strokes: StrokeInput[];
  onChange: (strokes: StrokeInput[]) => void;
  colour: RGB;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<PressurePoint[] | null>(null);
  const dpr = window.devicePixelRatio || 1;
  const ink = `rgb(${colour.map((c) => Math.round(c * 255)).join(',')})`;
  const widthFor = (p: PressurePoint) => (p.pressure > 0 && Math.abs(p.pressure - 0.5) > 0.01 ? 2.8 * (0.35 + 0.95 * p.pressure) : 2.8);
  const redraw = (list: StrokeInput[]) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PAD_W, PAD_H);
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of list) {
      const pts = stroke.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, widthFor(pts[0]) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 1; i < pts.length; i++) {
        ctx.beginPath();
        ctx.lineWidth = (widthFor(pts[i - 1]) + widthFor(pts[i])) / 2;
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
  };
  useEffect(() => redraw(strokes));
  const point = (e: PointerEvent | ReactPointerEvent): PressurePoint => {
    const box = canvas.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * PAD_W,
      y: ((e.clientY - box.top) / box.height) * PAD_H,
      pressure: e.pressure,
      time: e.timeStamp,
    };
  };
  return (
    <canvas
      ref={canvas}
      className="sign-pad"
      data-testid="signature-pad"
      aria-label="Signature drawing area"
      width={PAD_W * dpr}
      height={PAD_H * dpr}
      style={{ width: PAD_W, height: PAD_H }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        live.current = [point(e)];
        redraw([...strokes, { points: live.current }]);
      }}
      onPointerMove={(e) => {
        if (!live.current) return;
        const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const s of samples.length ? samples : [e.nativeEvent]) live.current.push(point(s));
        redraw([...strokes, { points: live.current }]);
      }}
      onPointerUp={() => {
        if (!live.current) return;
        const next = [...strokes, { points: live.current }];
        live.current = null;
        onChange(next);
      }}
      onPointerCancel={() => {
        live.current = null;
        redraw(strokes);
      }}
    />
  );
}

/** Saved signatures (or initials): pick one, delete one, or create a new one. */
export function SignaturePicker({
  kind,
  close,
  onPick,
  onCreate,
}: {
  kind: SignKind;
  close: () => void;
  onPick: (item: StoredSignItem) => void;
  onCreate: () => void;
}) {
  const items = useSignStore((s) => s.items).filter((i) => i.kind === kind);
  const noun = kind === 'initials' ? 'initials' : 'signature';
  return (
    <div className="sign-picker" data-testid="signature-picker">
      <div className="sign-saved" role="group" aria-label={`Saved ${noun}`}>
        {items.map((item) => (
          <div key={item.id} className="sign-saved-item">
            <button
              className="sign-saved-pick"
              aria-label={`Use ${item.name}`}
              onClick={() => {
                onPick(item);
                close();
              }}
            >
              <img src={`data:image/png;base64,${item.png}`} alt={item.name} />
            </button>
            <button
              className="icon-button"
              aria-label={`Delete ${item.name}`}
              title={`Delete saved ${noun}`}
              onClick={() => void removeSignItem(item.id)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <footer>
        <button onClick={close}>Cancel</button>
        <button
          className="primary"
          onClick={() => {
            close();
            onCreate();
          }}
        >
          New {noun}
        </button>
      </footer>
    </div>
  );
}
