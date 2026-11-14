/** Header and footer, watermark and background dialogs, with a live preview of the first page. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, Trash2 } from 'lucide-react';
import type { BackgroundSpec, HeaderFooterSpec, HeaderSlot, StampInfo, StampSpec, WatermarkSpec } from '../../../../engine/pages/stamps';
import type { FontFamily } from '../../../../engine/pages/text';
import { Button, Dialog } from '../../../ui';
import { friendlyError, notify, pageContext, pageOp, pickFiles, plural, type PickedFile } from '../../organize/pageActions';
import {
  ErrorText,
  Footer,
  LengthInput,
  PixelCanvas,
  Row,
  Section,
  UnitSelect,
  hexToRgb,
  rgbToHex,
  storedUnit,
  usePageScope,
  type Unit,
} from '../fields';
import type { DialogProps } from './structure';

const FONTS: FontFamily[] = ['Helvetica', 'Times', 'Courier', 'Noto Naskh Arabic'];
const FONT_LABELS: Record<FontFamily, string> = { Helvetica: 'Sans serif (Helvetica)', Times: 'Serif (Times)', Courier: 'Monospace (Courier)', 'Noto Naskh Arabic': 'Arabic (Noto Naskh)' };
const PREVIEW_BOX = 320;

type Image = { pixels: Uint8ClampedArray; width: number; height: number };

/** Existing stamps of one kind, and the choice to replace them or add another. */
function useExisting(docId: string, kind: StampSpec['kind']) {
  const [stamps, setStamps] = useState<StampInfo[] | null>(null);
  const [replace, setReplace] = useState(true);
  useEffect(() => {
    let live = true;
    void pageContext()
      .engine.call('pages.listStamps', { docId }, { priority: 160 })
      .then((all) => live && setStamps(all.filter((s) => s.kind === kind)))
      .catch(() => live && setStamps([]));
    return () => {
      live = false;
    };
  }, [docId, kind]);
  const current = stamps?.[stamps.length - 1];
  return { stamps: stamps ?? [], current, replaceId: replace && current ? current.id : undefined, replace, setReplace, loaded: stamps !== null };
}

function ExistingNotice({ what, existing }: { what: string; existing: ReturnType<typeof useExisting> }) {
  if (!existing.current) return null;
  return (
    <div className="pt-existing" role="status">
      <span>
        This document already has {existing.stamps.length === 1 ? `a ${what}` : `${existing.stamps.length} ${what}s`} ({plural(existing.current.pageCount, 'page')}).
      </span>
      <label>
        <input type="radio" checked={existing.replace} onChange={() => existing.setReplace(true)} />
        Replace it
      </label>
      <label>
        <input type="radio" checked={!existing.replace} onChange={() => existing.setReplace(false)} />
        Add another
      </label>
    </div>
  );
}

/** Debounced engine preview of the first target page with the stamp applied. */
function useStampPreview(docId: string, pageId: number | undefined, page: { width: number; height: number }, spec: StampSpec | null, replaceId: string | undefined, revision: number, scopeIds: readonly number[] = []) {
  const [image, setImage] = useState<Image | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => (spec ? JSON.stringify({ ...spec, image: spec.kind === 'watermark' && spec.image ? spec.image.byteLength : undefined }) : ''), [spec]);
  const scale = Math.min(PREVIEW_BOX / page.width, PREVIEW_BOX / page.height);
  useEffect(() => {
    if (!spec || pageId === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      const position = Math.max(0, scopeIds.indexOf(pageId));
      const args = { docId, pageId, spec: spec.kind === 'watermark' && spec.image ? { ...spec, image: spec.image.slice(0) } : spec, scale, replaceId, position, count: Math.max(1, scopeIds.length) };
      pageContext()
        .engine.call('pages.stampPreview', args, { priority: 140 })
        .then((result) => {
          if (!live) return;
          setImage(result);
          setError(null);
        })
        .catch((e) => live && setError(friendlyError(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The key captures the spec contents.
  }, [key, docId, pageId, scale, replaceId, revision, scopeIds.length, scopeIds.indexOf(pageId ?? -1)]);
  return { image, error, scale };
}

function Preview({ image, scale, page, label, error }: { image: Image | null; scale: number; page: { width: number; height: number }; label: string; error: string | null }) {
  return (
    <div className="pt-preview" aria-label="Preview">
      <div className="pt-preview-frame" style={{ width: Math.round(page.width * scale), height: Math.round(page.height * scale) }}>
        <PixelCanvas image={image} label={label} />
      </div>
      <span className={error ? 'pt-error' : 'muted'}>{error ?? label}</span>
    </div>
  );
}

const TOKENS: [string, string][] = [
  ['{page}', 'Page number'],
  ['{pages}', 'Total pages'],
  ['{label}', 'Page label'],
  ['{date}', 'Date'],
  ['{filename}', 'File name'],
  ['{bates}', 'Bates number'],
];
const SLOTS: [HeaderSlot, string][] = [
  ['topLeft', 'Header left'],
  ['topCenter', 'Header centre'],
  ['topRight', 'Header right'],
  ['bottomLeft', 'Footer left'],
  ['bottomCenter', 'Footer centre'],
  ['bottomRight', 'Footer right'],
];
type DateFormat = 'dmy' | 'long' | 'iso' | 'mdy';
function formatDate(format: DateFormat, date = new Date()): string {
  if (format === 'iso') return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (format === 'long') return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  if (format === 'mdy') return date.toLocaleDateString('en-US');
  return date.toLocaleDateString('en-GB');
}

export function HeaderFooterDialog({ tab, close }: DialogProps) {
  const existing = useExisting(tab.info.docId, 'header-footer');
  const scope = usePageScope(tab);
  const [unit, setUnit] = useState<Unit>(storedUnit());
  const [texts, setTexts] = useState<Partial<Record<HeaderSlot, string>>>({ bottomCenter: 'Page {page} of {pages}' });
  const [font, setFont] = useState<FontFamily>('Helvetica');
  const [size, setSize] = useState('10');
  const [color, setColor] = useState('#000000');
  const [bold, setBold] = useState(false);
  const [margins, setMargins] = useState({ top: 28, bottom: 28, left: 42, right: 42 });
  const [start, setStart] = useState('1');
  const [dateFormat, setDateFormat] = useState<DateFormat>('dmy');
  const [bates, setBates] = useState({ prefix: '', start: '1', digits: '6', suffix: '' });
  const focused = useRef<{ slot: HeaderSlot; input: HTMLInputElement } | null>(null);
  const prefilled = useRef(false);
  const { busy, setBusy } = useFlag();
  useEffect(() => {
    // Editing an existing header and footer starts from its settings.
    const spec = existing.current?.spec as HeaderFooterSpec | undefined;
    if (!spec || prefilled.current) return;
    prefilled.current = true;
    setTexts(spec.texts ?? {});
    if (spec.font) setFont(spec.font);
    if (spec.size) setSize(String(spec.size));
    if (spec.color) setColor(rgbToHex(spec.color));
    setBold(Boolean(spec.bold));
    if (spec.margins) setMargins(spec.margins);
    if (spec.startNumber) setStart(String(spec.startNumber));
    if (spec.bates) setBates({ prefix: spec.bates.prefix ?? '', start: String(spec.bates.start), digits: String(spec.bates.digits), suffix: spec.bates.suffix ?? '' });
  }, [existing.current]);
  const usesBates = Object.values(texts).some((t) => t?.includes('{bates}'));
  const usesDate = Object.values(texts).some((t) => t?.includes('{date}'));
  const numberSize = Number(size);
  const problem =
    !Object.values(texts).some((t) => t?.trim())
      ? 'Type the text for at least one position.'
      : !(numberSize >= 4 && numberSize <= 96)
        ? 'Text size must be between 4 and 96 points.'
        : !Number.isInteger(Number(start))
          ? 'The first page number must be a whole number.'
          : usesBates && !(Number.isInteger(Number(bates.start)) && Number(bates.digits) >= 1 && Number(bates.digits) <= 12)
            ? 'Bates numbers need a start number and 1 to 12 digits.'
            : null;
  const spec: HeaderFooterSpec | null = problem
    ? null
    : {
        kind: 'header-footer',
        texts,
        font,
        size: numberSize,
        color: hexToRgb(color),
        bold,
        margins,
        startNumber: Number(start),
        dateText: formatDate(dateFormat),
        fileName: tab.file.name,
        bates: usesBates ? { prefix: bates.prefix, start: Number(bates.start), digits: Number(bates.digits), suffix: bates.suffix } : undefined,
        direction: 'auto',
      };
  const page = tab.info.pages.find((p) => p.id === scope.ids[0]) ?? tab.info.pages[tab.page];
  const preview = useStampPreview(tab.info.docId, page?.id, page, spec, existing.replaceId, tab.info.revision, scope.ids);
  const error = scope.error ?? problem;
  const insertToken = (token: string) => {
    const target = focused.current;
    const slot = target?.slot ?? 'bottomCenter';
    const value = texts[slot] ?? '';
    const at = target?.input.selectionStart ?? value.length;
    const end = target?.input.selectionEnd ?? at;
    setTexts({ ...texts, [slot]: value.slice(0, at) + token + value.slice(end) });
    requestAnimationFrame(() => {
      target?.input.focus();
      target?.input.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const apply = async () => {
    if (!spec) return;
    setBusy(true);
    try {
      const result = await pageOp('pages.stamp', { docId: tab.info.docId, pageIds: scope.ids, spec, replaceId: existing.replaceId });
      if (!result) return;
      notify(`${existing.replaceId ? 'Updated' : 'Added'} the header and footer on ${plural(scope.ids.length, 'page')}.`);
      close();
    } finally {
      setBusy(false);
    }
  };
  const removeAll = async () => {
    setBusy(true);
    try {
      const result = await pageOp('pages.removeStamps', { docId: tab.info.docId, kind: 'header-footer' });
      if (result) {
        notify(`Removed the header and footer from ${plural(result.removedFrom, 'page')}.`);
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Header and footer" onClose={close}>
      <div className="pt-body pt-wide">
        <ExistingNotice what="header and footer" existing={existing} />
        <div className="pt-columns">
          <div>
            <div className="pt-slots">
              {SLOTS.map(([slot, label]) => (
                <label key={slot} className="pt-slot">
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    dir="auto"
                    value={texts[slot] ?? ''}
                    onFocus={(e) => (focused.current = { slot, input: e.currentTarget })}
                    onChange={(e) => setTexts({ ...texts, [slot]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <div className="pt-tokens" role="group" aria-label="Insert">
              {TOKENS.map(([token, label]) => (
                <button key={token} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertToken(token)}>
                  {label}
                </button>
              ))}
            </div>
            <Section title="Text">
              <div className="pt-inline pt-wrap">
                <select aria-label="Font" value={font} onChange={(e) => setFont(e.target.value as FontFamily)}>
                  {FONTS.map((f) => (
                    <option key={f} value={f}>
                      {FONT_LABELS[f]}
                    </option>
                  ))}
                </select>
                <label className="pt-length">
                  <span>Size</span>
                  <input aria-label="Text size" type="number" min={4} max={96} value={size} onChange={(e) => setSize(e.target.value)} />
                  <span className="pt-unit-label">pt</span>
                </label>
                <input type="color" aria-label="Text colour" value={color} onChange={(e) => setColor(e.target.value)} />
                <label className="pt-check">
                  <input type="checkbox" checked={bold} disabled={font === 'Noto Naskh Arabic'} onChange={(e) => setBold(e.target.checked)} />
                  Bold
                </label>
              </div>
              <div className="pt-inline pt-wrap">
                <label className="pt-length">
                  <span>First page number</span>
                  <input aria-label="First page number" type="number" value={start} onChange={(e) => setStart(e.target.value)} />
                </label>
                {usesDate && (
                  <select aria-label="Date format" value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
                    <option value="dmy">{formatDate('dmy')}</option>
                    <option value="long">{formatDate('long')}</option>
                    <option value="iso">{formatDate('iso')}</option>
                    <option value="mdy">{formatDate('mdy')} (US)</option>
                  </select>
                )}
              </div>
              {usesBates && (
                <div className="pt-inline pt-wrap">
                  <input aria-label="Bates prefix" placeholder="Prefix" value={bates.prefix} onChange={(e) => setBates({ ...bates, prefix: e.target.value })} />
                  <input aria-label="Bates start" type="number" className="pt-number" value={bates.start} onChange={(e) => setBates({ ...bates, start: e.target.value })} />
                  <label className="pt-length">
                    <span>Digits</span>
                    <input aria-label="Bates digits" type="number" min={1} max={12} value={bates.digits} onChange={(e) => setBates({ ...bates, digits: e.target.value })} />
                  </label>
                  <input aria-label="Bates suffix" placeholder="Suffix" value={bates.suffix} onChange={(e) => setBates({ ...bates, suffix: e.target.value })} />
                </div>
              )}
            </Section>
            <Section title="Margins">
              <div className="pt-margins-row">
                <div className="pt-margins">
                  <LengthInput label="Top" points={margins.top} unit={unit} max={400} onChange={(v) => setMargins((m) => ({ ...m, top: v }))} />
                  <LengthInput label="Bottom" points={margins.bottom} unit={unit} max={400} onChange={(v) => setMargins((m) => ({ ...m, bottom: v }))} />
                  <LengthInput label="Left" points={margins.left} unit={unit} max={400} onChange={(v) => setMargins((m) => ({ ...m, left: v }))} />
                  <LengthInput label="Right" points={margins.right} unit={unit} max={400} onChange={(v) => setMargins((m) => ({ ...m, right: v }))} />
                </div>
                <UnitSelect unit={unit} onChange={setUnit} />
              </div>
            </Section>
            {scope.element}
          </div>
          <Preview image={preview.image} scale={preview.scale} page={page} error={preview.error} label={`Preview of page ${page.index + 1}`} />
        </div>
      </div>
      <Footer
        busy={busy}
        disabled={Boolean(error)}
        action={existing.replaceId ? 'Update' : 'Add'}
        onAction={() => void apply()}
        onCancel={close}
        extra={
          <>
            {existing.current && (
              <Button type="button" onClick={() => void removeAll()} disabled={busy}>
                <Trash2 size={15} />
                Remove
              </Button>
            )}
            <ErrorText>{error && Object.values(texts).some((t) => t?.trim()) ? error : null}</ErrorText>
          </>
        }
      />
    </Dialog>
  );
}

function useFlag() {
  const [busy, setBusy] = useState(false);
  return { busy, setBusy };
}

const POSITIONS: [string, number, number][] = [
  ['Top left', 0.25, 0.8],
  ['Top', 0.5, 0.8],
  ['Top right', 0.75, 0.8],
  ['Left', 0.25, 0.5],
  ['Centre', 0.5, 0.5],
  ['Right', 0.75, 0.5],
  ['Bottom left', 0.25, 0.2],
  ['Bottom', 0.5, 0.2],
  ['Bottom right', 0.75, 0.2],
];

export function WatermarkDialog({ tab, close }: DialogProps) {
  const existing = useExisting(tab.info.docId, 'watermark');
  const scope = usePageScope(tab);
  const [source, setSource] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [image, setImage] = useState<PickedFile | null>(null);
  const [font, setFont] = useState<FontFamily>('Helvetica');
  const [size, setSize] = useState('64');
  const [bold, setBold] = useState(true);
  const [color, setColor] = useState('#c0392b');
  const [opacity, setOpacity] = useState(25);
  const [rotation, setRotation] = useState('45');
  const [position, setPosition] = useState(4);
  const [scale, setScale] = useState(50);
  const [behind, setBehind] = useState(false);
  const { busy, setBusy } = useFlag();
  const prefilled = useRef(false);
  useEffect(() => {
    const spec = existing.current?.spec as WatermarkSpec | undefined;
    if (!spec || prefilled.current) return;
    prefilled.current = true;
    if (spec.text) setText(spec.text);
    if (spec.font) setFont(spec.font);
    if (spec.size) setSize(String(spec.size));
    if (spec.color) setColor(rgbToHex(spec.color));
    setBold(Boolean(spec.bold));
    setOpacity(Math.round(spec.opacity * 100));
    setRotation(String(spec.rotation));
    setBehind(spec.behind);
    if (spec.scale) setScale(Math.round(spec.scale * 100));
    const at = POSITIONS.findIndex(([, x, y]) => Math.abs(x - (spec.position?.x ?? 0.5)) < 0.01 && Math.abs(y - (spec.position?.y ?? 0.5)) < 0.01);
    if (at >= 0) setPosition(at);
  }, [existing.current]);
  const sizeNumber = Number(size);
  const rotationNumber = Number(rotation);
  const problem =
    source === 'text' && !text.trim()
      ? 'Type the watermark text.'
      : source === 'image' && !image
        ? 'Choose a PNG or JPEG image.'
        : source === 'text' && !(sizeNumber >= 4 && sizeNumber <= 500)
          ? 'Text size must be between 4 and 500 points.'
          : !Number.isFinite(rotationNumber)
            ? 'Rotation must be a number of degrees.'
            : null;
  const spec: WatermarkSpec | null = useMemo(
    () =>
      problem
        ? null
        : {
            kind: 'watermark',
            text: source === 'text' ? text : undefined,
            image: source === 'image' ? image?.bytes : undefined,
            font,
            bold,
            size: sizeNumber,
            color: hexToRgb(color),
            opacity: opacity / 100,
            rotation: rotationNumber,
            scale: scale / 100,
            position: { x: POSITIONS[position][1], y: POSITIONS[position][2] },
            behind,
          },
    [problem, source, text, image, font, bold, sizeNumber, color, opacity, rotationNumber, scale, position, behind],
  );
  const page = tab.info.pages.find((p) => p.id === scope.ids[0]) ?? tab.info.pages[tab.page];
  const preview = useStampPreview(tab.info.docId, page?.id, page, spec, existing.replaceId, tab.info.revision, scope.ids);
  const error = scope.error ?? problem;
  const apply = async () => {
    if (!spec) return;
    setBusy(true);
    try {
      const args = { docId: tab.info.docId, pageIds: scope.ids, spec: spec.image ? { ...spec, image: spec.image.slice(0) } : spec, replaceId: existing.replaceId };
      const result = await pageOp('pages.stamp', args);
      if (!result) return;
      notify(`${existing.replaceId ? 'Updated' : 'Added'} the watermark on ${plural(scope.ids.length, 'page')}.`);
      close();
    } finally {
      setBusy(false);
    }
  };
  const removeAll = async () => {
    setBusy(true);
    try {
      const result = await pageOp('pages.removeStamps', { docId: tab.info.docId, kind: 'watermark' });
      if (result) {
        notify(`Removed the watermark from ${plural(result.removedFrom, 'page')}.`);
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Watermark" onClose={close}>
      <div className="pt-body pt-wide">
        <ExistingNotice what="watermark" existing={existing} />
        <div className="pt-columns">
          <div>
            <div className="pt-choice" role="radiogroup" aria-label="Watermark source">
              <label>
                <input type="radio" name="pt-wm-source" checked={source === 'text'} onChange={() => setSource('text')} />
                Text
              </label>
              <label>
                <input type="radio" name="pt-wm-source" checked={source === 'image'} onChange={() => setSource('image')} />
                Image
              </label>
            </div>
            {source === 'text' ? (
              <Section title="Text">
                <input aria-label="Watermark text" dir="auto" className="pt-full" value={text} onChange={(e) => setText(e.target.value)} />
                <div className="pt-inline pt-wrap">
                  <select aria-label="Font" value={font} onChange={(e) => setFont(e.target.value as FontFamily)}>
                    {FONTS.map((f) => (
                      <option key={f} value={f}>
                        {FONT_LABELS[f]}
                      </option>
                    ))}
                  </select>
                  <label className="pt-length">
                    <span>Size</span>
                    <input aria-label="Text size" type="number" min={4} max={500} value={size} onChange={(e) => setSize(e.target.value)} />
                    <span className="pt-unit-label">pt</span>
                  </label>
                  <input type="color" aria-label="Text colour" value={color} onChange={(e) => setColor(e.target.value)} />
                  <label className="pt-check">
                    <input type="checkbox" checked={bold} disabled={font === 'Noto Naskh Arabic'} onChange={(e) => setBold(e.target.checked)} />
                    Bold
                  </label>
                </div>
              </Section>
            ) : (
              <Section title="Image">
                <div className="pt-inline">
                  <Button type="button" onClick={() => void pickFiles().then((f) => f[0] && setImage(f[0]))}>
                    <FilePlus2 size={15} />
                    Choose…
                  </Button>
                  <span className="pt-file-name">{image?.name ?? 'No image chosen'}</span>
                </div>
                <label className="pt-slider">
                  <span>Width</span>
                  <input type="range" aria-label="Image width" min={5} max={100} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
                  <span className="muted">{scale}% of the page</span>
                </label>
              </Section>
            )}
            <Section title="Appearance">
              <label className="pt-slider">
                <span>Opacity</span>
                <input type="range" aria-label="Opacity" min={5} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                <span className="muted">{opacity}%</span>
              </label>
              <div className="pt-inline pt-wrap">
                <label className="pt-length">
                  <span>Rotation</span>
                  <input aria-label="Rotation" type="number" min={-360} max={360} step={15} value={rotation} onChange={(e) => setRotation(e.target.value)} />
                  <span className="pt-unit-label">°</span>
                </label>
                <div className="pt-position" role="radiogroup" aria-label="Position">
                  {POSITIONS.map(([label], i) => (
                    <button key={label} type="button" role="radio" aria-checked={position === i} aria-label={label} title={label} onClick={() => setPosition(i)} />
                  ))}
                </div>
              </div>
              <div className="pt-choice">
                <label>
                  <input type="radio" name="pt-wm-layer" checked={!behind} onChange={() => setBehind(false)} />
                  On top of the page
                </label>
                <label>
                  <input type="radio" name="pt-wm-layer" checked={behind} onChange={() => setBehind(true)} />
                  Behind the page content
                </label>
              </div>
            </Section>
            {scope.element}
          </div>
          <Preview image={preview.image} scale={preview.scale} page={page} error={preview.error} label={`Preview of page ${page.index + 1}`} />
        </div>
      </div>
      <Footer
        busy={busy}
        disabled={Boolean(error)}
        action={existing.replaceId ? 'Update' : 'Add'}
        onAction={() => void apply()}
        onCancel={close}
        extra={
          existing.current && (
            <Button type="button" onClick={() => void removeAll()} disabled={busy}>
              <Trash2 size={15} />
              Remove
            </Button>
          )
        }
      />
    </Dialog>
  );
}

export function BackgroundDialog({ tab, close }: DialogProps) {
  const existing = useExisting(tab.info.docId, 'background');
  const scope = usePageScope(tab);
  const [color, setColor] = useState('#fff8e1');
  const [opacity, setOpacity] = useState(100);
  const { busy, setBusy } = useFlag();
  const prefilled = useRef(false);
  useEffect(() => {
    const spec = existing.current?.spec as BackgroundSpec | undefined;
    if (!spec || prefilled.current) return;
    prefilled.current = true;
    setColor(rgbToHex(spec.color));
    setOpacity(Math.round((spec.opacity ?? 1) * 100));
  }, [existing.current]);
  const spec: BackgroundSpec = useMemo(() => ({ kind: 'background', color: hexToRgb(color), opacity: opacity / 100 }), [color, opacity]);
  const page = tab.info.pages.find((p) => p.id === scope.ids[0]) ?? tab.info.pages[tab.page];
  const preview = useStampPreview(tab.info.docId, page?.id, page, spec, existing.replaceId, tab.info.revision, scope.ids);
  const apply = async () => {
    setBusy(true);
    try {
      const result = await pageOp('pages.stamp', { docId: tab.info.docId, pageIds: scope.ids, spec, replaceId: existing.replaceId });
      if (!result) return;
      notify(`${existing.replaceId ? 'Updated' : 'Added'} the background on ${plural(scope.ids.length, 'page')}.`);
      close();
    } finally {
      setBusy(false);
    }
  };
  const removeAll = async () => {
    setBusy(true);
    try {
      const result = await pageOp('pages.removeStamps', { docId: tab.info.docId, kind: 'background' });
      if (result) {
        notify(`Removed the background from ${plural(result.removedFrom, 'page')}.`);
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Background" onClose={close}>
      <div className="pt-body pt-wide">
        <ExistingNotice what="background" existing={existing} />
        <div className="pt-columns">
          <div>
            <Row label="Colour">
              <input type="color" aria-label="Background colour" value={color} onChange={(e) => setColor(e.target.value)} />
            </Row>
            <Row label="Opacity">
              <label className="pt-slider">
                <input type="range" aria-label="Opacity" min={5} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                <span className="muted">{opacity}%</span>
              </label>
            </Row>
            {scope.element}
            <p className="pt-note">The colour is drawn behind the page content, so text and images stay on top.</p>
          </div>
          <Preview image={preview.image} scale={preview.scale} page={page} error={preview.error} label={`Preview of page ${page.index + 1}`} />
        </div>
      </div>
      <Footer
        busy={busy}
        disabled={Boolean(scope.error)}
        action={existing.replaceId ? 'Update' : 'Add'}
        onAction={() => void apply()}
        onCancel={close}
        extra={
          existing.current && (
            <Button type="button" onClick={() => void removeAll()} disabled={busy}>
              <Trash2 size={15} />
              Remove
            </Button>
          )
        }
      />
    </Dialog>
  );
}
