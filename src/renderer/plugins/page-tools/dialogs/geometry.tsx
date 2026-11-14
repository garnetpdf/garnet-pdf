/** Dialogs that change page geometry: crop, page size, pages per sheet. */
import { useMemo, useState } from 'react';
import { Link2, Link2Off, ScanLine } from 'lucide-react';
import type { Margins } from '../../../../engine/pages/geometry';
import { Button, Dialog, IconButton } from '../../../ui';
import { notify, openAsNewTab, pageOp, plural } from '../../organize/pageActions';
import {
  ErrorText,
  Footer,
  LengthInput,
  PAPER,
  PixelCanvas,
  Row,
  Section,
  UnitSelect,
  fromPoints,
  storedUnit,
  usePageImage,
  usePageScope,
  type Unit,
} from '../fields';
import type { DialogProps } from './structure';

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

const PREVIEW_BOX = 260;

export function CropDialog({ tab, close }: DialogProps) {
  const scope = usePageScope(tab);
  const [unit, setUnit] = useState<Unit>(storedUnit());
  const [margins, setMargins] = useState<Margins>({ top: 0, bottom: 0, left: 0, right: 0 });
  const [linked, setLinked] = useState(false);
  const [detected, setDetected] = useState<Record<number, Margins | null> | null>(null);
  const [remove, setRemove] = useState(false);
  const { busy, run } = useBusy();
  const previewId = scope.ids[0] ?? tab.info.pages[tab.page]?.id;
  const page = tab.info.pages.find((p) => p.id === previewId) ?? tab.info.pages[0];
  const scale = Math.min(PREVIEW_BOX / page.width, PREVIEW_BOX / page.height);
  const image = usePageImage(tab.info.docId, page.id, scale, tab.info.revision);
  const shown = detected?.[page.id] ?? margins;
  const tooBig = scope.ids.some((id) => {
    const p = tab.info.pages.find((x) => x.id === id);
    if (!p) return false;
    const m = detected?.[id] ?? margins;
    return m.left + m.right >= p.width - 10 || m.top + m.bottom >= p.height - 10;
  });
  const nothing = !detected && margins.top + margins.bottom + margins.left + margins.right === 0;
  const error = scope.error ?? (tooBig ? 'The margins leave no page. Make them smaller.' : nothing ? 'Set at least one margin.' : null);
  const setSide = (side: keyof Margins, points: number) => {
    setDetected(null);
    setMargins((m) => (linked ? { top: points, bottom: points, left: points, right: points } : { ...m, [side]: points }));
  };
  const detect = () =>
    run(async () => {
      const result = await pageOp('pages.detectMargins', { docId: tab.info.docId, pageIds: scope.ids, padding: 6 });
      if (!result) return;
      const blank = Object.values(result).filter((m) => !m).length;
      setDetected(result);
      const first = result[scope.ids[0]];
      if (first) setMargins(first);
      if (blank) notify(`${plural(blank, 'page')} looked empty and will not be cropped.`);
    });
  const submit = () =>
    run(async () => {
      if (error) return;
      const marginsByPage = detected
        ? Object.fromEntries(Object.entries(detected).filter((entry): entry is [string, Margins] => Boolean(entry[1])))
        : undefined;
      const ids = detected ? scope.ids.filter((id) => detected[id]) : scope.ids;
      if (!ids.length) {
        notify('There is nothing to crop on these pages.');
        return;
      }
      const result = await pageOp('pages.crop', { docId: tab.info.docId, pageIds: ids, margins: detected ? undefined : margins, marginsByPage, removeContent: remove });
      if (!result) return;
      notify(`Cropped ${plural(ids.length, 'page')}.`);
      close();
    });
  return (
    <Dialog title="Crop pages" onClose={close}>
      <div className="pt-body pt-wide">
        <div className="pt-columns">
          <div>
            <Section title="Margins to remove">
              <div className="pt-margins">
                <LengthInput label="Top" points={margins.top} unit={unit} onChange={(v) => setSide('top', v)} />
                <LengthInput label="Bottom" points={margins.bottom} unit={unit} onChange={(v) => setSide('bottom', v)} />
                <LengthInput label="Left" points={margins.left} unit={unit} onChange={(v) => setSide('left', v)} />
                <LengthInput label="Right" points={margins.right} unit={unit} onChange={(v) => setSide('right', v)} />
              </div>
              <div className="pt-inline">
                <IconButton label={linked ? 'Margins linked' : 'Link margins'} aria-pressed={linked} onClick={() => setLinked((v) => !v)}>
                  {linked ? <Link2 size={15} /> : <Link2Off size={15} />}
                </IconButton>
                <UnitSelect unit={unit} onChange={setUnit} />
                <Button type="button" disabled={busy || Boolean(scope.error)} onClick={() => void detect()}>
                  <ScanLine size={15} />
                  Remove white margins
                </Button>
              </div>
              {detected && <p className="pt-note">Margins found for each page separately. Changing a value uses the same margins for all pages.</p>}
            </Section>
            {scope.element}
            <label className="pt-check">
              <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
              Remove the cropped content permanently
            </label>
            <p className="pt-note">
              {remove
                ? 'Text, images and drawings outside the crop are deleted and the page is made smaller. Undo works until you close the document.'
                : 'Cropping hides the margins; the content stays in the file and can be restored.'}
            </p>
          </div>
          <div className="pt-preview" aria-label="Crop preview">
            <div className="pt-preview-frame" style={{ width: Math.round(page.width * scale), height: Math.round(page.height * scale) }}>
              <PixelCanvas image={image} label={`Page ${page.index + 1}`} />
              <div
                className="pt-crop-box"
                style={{
                  left: shown.left * scale,
                  top: shown.top * scale,
                  right: shown.right * scale,
                  bottom: shown.bottom * scale,
                }}
              />
            </div>
            <span className="muted">
              Page {page.index + 1} · {fromPoints(page.width - shown.left - shown.right, unit)} × {fromPoints(page.height - shown.top - shown.bottom, unit)} {unit} after cropping
            </span>
          </div>
        </div>
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action="Crop" onAction={() => void submit()} onCancel={close} extra={<ErrorText>{tooBig ? error : null}</ErrorText>} />
    </Dialog>
  );
}

export function PageSizeDialog({ tab, close }: DialogProps) {
  const scope = usePageScope(tab);
  const [unit, setUnit] = useState<Unit>(storedUnit());
  const [preset, setPreset] = useState('A4');
  const [orientation, setOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [custom, setCustom] = useState<[number, number]>(PAPER.A4);
  const [mode, setMode] = useState<'fit' | 'centre'>('fit');
  const { busy, run } = useBusy();
  const base = preset === 'custom' ? custom : PAPER[preset];
  const sizeFor = (portraitPage: boolean): [number, number] => {
    const [w, h] = [Math.min(...base), Math.max(...base)];
    const landscape = orientation === 'landscape' || (orientation === 'auto' && !portraitPage);
    return landscape ? [h, w] : [w, h];
  };
  const error = scope.error ?? (base[0] < 36 || base[1] < 36 ? 'Pages must be at least 0.5 inch on each side.' : null);
  const submit = () =>
    run(async () => {
      if (error) return;
      // One call per orientation so landscape pages stay landscape with "Match each page".
      const groups = new Map<string, number[]>();
      for (const id of scope.ids) {
        const p = tab.info.pages.find((x) => x.id === id);
        if (!p) continue;
        const size = sizeFor(p.height >= p.width).join('x');
        groups.set(size, [...(groups.get(size) ?? []), id]);
      }
      let ok = true;
      for (const [size, ids] of groups) {
        const [w, h] = size.split('x').map(Number);
        ok = Boolean(await pageOp('pages.resize', { docId: tab.info.docId, pageIds: ids, size: [w, h], mode })) && ok;
        if (!ok) break;
      }
      if (!ok) return;
      notify(`Changed the size of ${plural(scope.ids.length, 'page')}.`);
      close();
    });
  return (
    <Dialog title="Page size" onClose={close}>
      <div className="pt-body">
        <Row label="Size">
          <div className="pt-inline">
            <select aria-label="Paper size" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {Object.entries(PAPER).map(([name, [w, h]]) => (
                <option key={name} value={name}>
                  {name} ({fromPoints(w, unit)} × {fromPoints(h, unit)} {unit})
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
            <UnitSelect unit={unit} onChange={setUnit} />
          </div>
        </Row>
        {preset === 'custom' && (
          <Row label="Custom size">
            <div className="pt-inline">
              <LengthInput label="Width" points={custom[0]} unit={unit} min={36} max={14400} onChange={(v) => setCustom(([, h]) => [v, h])} />
              <LengthInput label="Height" points={custom[1]} unit={unit} min={36} max={14400} onChange={(v) => setCustom(([w]) => [w, v])} />
            </div>
          </Row>
        )}
        <Row label="Orientation">
          <select aria-label="Orientation" value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
            <option value="auto">Match each page</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Row>
        <Row label="Content">
          <div className="pt-choice">
            <label>
              <input type="radio" name="pt-resize-mode" checked={mode === 'fit'} onChange={() => setMode('fit')} />
              Scale to fit the new size
            </label>
            <label>
              <input type="radio" name="pt-resize-mode" checked={mode === 'centre'} onChange={() => setMode('centre')} />
              Keep the size and centre it
            </label>
          </div>
        </Row>
        {scope.element}
        <p className="pt-note">Comments, links and form fields move with the content.</p>
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action="Apply" onAction={() => void submit()} onCancel={close} />
    </Dialog>
  );
}

const PER_SHEET = [2, 4, 6, 9] as const;

export function NupDialog({ tab, close }: DialogProps) {
  const scope = usePageScope(tab);
  const [perSheet, setPerSheet] = useState<(typeof PER_SHEET)[number]>(2);
  const [preset, setPreset] = useState('A4');
  const [orientation, setOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [order, setOrder] = useState<'across' | 'down'>('across');
  const [border, setBorder] = useState(false);
  const { busy, run } = useBusy();
  const sheets = Math.ceil(scope.ids.length / perSheet);
  const layout = useMemo(() => {
    const first = tab.info.pages.find((p) => p.id === scope.ids[0]) ?? tab.info.pages[0];
    const portraitSource = first.height >= first.width;
    const landscape = orientation === 'landscape' || (orientation === 'auto' && (perSheet === 2 || perSheet === 6 ? portraitSource : !portraitSource));
    const grid = perSheet === 2 ? (landscape ? [2, 1] : [1, 2]) : perSheet === 4 ? [2, 2] : perSheet === 6 ? (landscape ? [3, 2] : [2, 3]) : [3, 3];
    return { landscape, cols: grid[0], rows: grid[1] };
  }, [perSheet, orientation, scope.ids, tab.info.pages]);
  const submit = () =>
    run(async () => {
      if (scope.error) return;
      const result = await pageOp('pages.nup', {
        docId: tab.info.docId,
        pageIds: scope.ids,
        perSheet,
        sheet: PAPER[preset],
        orientation,
        order,
        border,
        name: tab.file.name,
      });
      if (!result) return;
      await openAsNewTab(result.bytes, result.name);
      close();
    });
  const cells = layout.cols * layout.rows;
  return (
    <Dialog title="Pages per sheet" onClose={close}>
      <div className="pt-body pt-wide">
        <div className="pt-columns">
          <div>
            <Row label="Pages per sheet">
              <div className="segmented" role="group" aria-label="Pages per sheet">
                {PER_SHEET.map((n) => (
                  <button key={n} type="button" aria-pressed={perSheet === n} onClick={() => setPerSheet(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Sheet">
              <div className="pt-inline">
                <select aria-label="Sheet size" value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {Object.keys(PAPER).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select aria-label="Orientation" value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
                  <option value="auto">Best fit</option>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>
            </Row>
            <Row label="Order">
              <select aria-label="Page order" value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
                <option value="across">Across, then down</option>
                <option value="down">Down, then across</option>
              </select>
            </Row>
            <Row label="Borders">
              <label className="pt-check">
                <input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} />
                Draw a thin border around each page
              </label>
            </Row>
            {scope.element}
          </div>
          <div className="pt-preview" aria-label="Sheet layout">
            <div
              className={`pt-sheet ${layout.landscape ? 'landscape' : ''}`}
              style={{ gridTemplateColumns: `repeat(${layout.cols}, 1fr)`, gridTemplateRows: `repeat(${layout.rows}, 1fr)` }}
            >
              {Array.from({ length: cells }, (_, i) => {
                const col = order === 'across' ? i % layout.cols : Math.floor(i / layout.rows);
                const row = order === 'across' ? Math.floor(i / layout.cols) : i % layout.rows;
                return (
                  <span key={i} className={border ? 'bordered' : ''} style={{ gridColumn: col + 1, gridRow: row + 1 }}>
                    {i + 1}
                  </span>
                );
              })}
            </div>
            <span className="muted">
              {plural(scope.ids.length, 'page')} on {plural(sheets, 'sheet')}
            </span>
          </div>
        </div>
        <p className="pt-note">Creates a new document in a new tab; this document is not changed.</p>
      </div>
      <Footer busy={busy} disabled={Boolean(scope.error)} action="Create" onAction={() => void submit()} onCancel={close} />
    </Dialog>
  );
}
