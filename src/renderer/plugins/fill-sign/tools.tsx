/** Fill & Sign page overlays: the default select/fill layer and the place-an-item tool. */
import { useState } from 'react';
import { Check, Dot, X } from 'lucide-react';
import { create } from 'zustand';
import type { EditPage, Point, Rect } from '../../plugin-host/types';
import type { AnnotCreateSpec, FillSignKind } from '../../../engine/tools/annots/types';
import { AnnotLayer, fitText } from '../comment/shared/AnnotLayer';
import { createAnnotation, select, useAnnots } from '../comment/shared/store';
import { pageSize, pctRect } from '../comment/shared/geometry';
import { FormsLayer } from '../forms/FormsLayer';
import type { FormWidget } from '../forms/store';
import { base64ToBytes, type StoredSignItem } from './store';

export interface Placement {
  kind: FillSignKind;
  item?: StoredSignItem;
}
export const usePlacing = create<{ placement: Placement | null }>(() => ({ placement: null }));

let finishPlacing: () => void = () => {};
let signField: (w: FormWidget) => void = () => {};
export function setFillSignApi(api: { finish: () => void; signField: (w: FormWidget) => void }) {
  finishPlacing = api.finish;
  signField = api.signField;
}

const DATE_KEY = 'garnet.fillsign.dateFormat';
export function formatToday(now = new Date()): string {
  let format = 'DD/MM/YYYY';
  try {
    format = localStorage.getItem(DATE_KEY) || format;
  } catch {
    // Default format.
  }
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  return format.replace('DD', dd).replace('MM', mm).replace('YYYY', yyyy);
}

const BLACK: [number, number, number] = [0, 0, 0];
const TEXT_SIZE = 12;

/** Size in points for a signature image placed on the page. */
export function imageSize(item: StoredSignItem, kind: FillSignKind): [number, number] {
  const maxW = kind === 'initials' ? 64 : 160;
  const maxH = kind === 'initials' ? 34 : 54;
  const ratio = item.width / item.height;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  return [w, h];
}

/** Fits an image of the given aspect ratio inside a rectangle, centred. */
export function fitInside(ratio: number, r: Rect, inset = 2): Rect {
  const width = Math.max(1, r[2] - r[0] - inset * 2);
  const height = Math.max(1, r[3] - r[1] - inset * 2);
  let w = width;
  let h = w / ratio;
  if (h > height) {
    h = height;
    w = h * ratio;
  }
  const cx = (r[0] + r[2]) / 2;
  const cy = (r[1] + r[3]) / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

export function itemSpec(placement: Placement, at: Point): AnnotCreateSpec | null {
  const [x, y] = at;
  switch (placement.kind) {
    case 'signature':
    case 'initials': {
      if (!placement.item) return null;
      const [w, h] = imageSize(placement.item, placement.kind);
      return {
        type: 'Stamp',
        rect: [x - w / 2, y - h / 2, x + w / 2, y + h / 2],
        image: base64ToBytes(placement.item.png),
        contents: placement.kind === 'initials' ? 'Initials' : 'Signature',
        fillSign: placement.kind,
      };
    }
    case 'date': {
      const text = formatToday();
      const [w, h] = fitText(text, TEXT_SIZE, 0);
      return {
        type: 'FreeText',
        intent: 'FreeTextTypeWriter',
        rect: [x, y - h / 2, x + w, y + h / 2],
        contents: text,
        fontSize: TEXT_SIZE,
        textColor: BLACK,
        borderWidth: 0,
        fillSign: 'date',
      };
    }
    case 'tick':
      return {
        type: 'Ink',
        ink: [
          [
            [x - 5, y],
            [x - 1.5, y + 4],
            [x + 5.5, y - 5],
          ],
        ],
        color: BLACK,
        borderWidth: 1.6,
        fillSign: 'tick',
      };
    case 'cross':
      return {
        type: 'Ink',
        ink: [
          [
            [x - 4.5, y - 4.5],
            [x + 4.5, y + 4.5],
          ],
          [
            [x + 4.5, y - 4.5],
            [x - 4.5, y + 4.5],
          ],
        ],
        color: BLACK,
        borderWidth: 1.6,
        fillSign: 'cross',
      };
    case 'dot':
      return {
        type: 'Circle',
        rect: [x - 3, y - 3, x + 3, y + 3],
        color: BLACK,
        interiorColor: BLACK,
        borderWidth: 0.5,
        fillSign: 'dot',
      };
    default:
      return null;
  }
}

export async function placeAt(page: EditPage, placement: Placement, at: Point) {
  if (placement.kind === 'text') {
    useAnnots.getState().set({
      draft: {
        kind: 'freetext',
        pageId: page.pageId,
        point: [at[0], at[1] - TEXT_SIZE * 0.7],
        spec: { intent: 'FreeTextTypeWriter', fontSize: TEXT_SIZE, textColor: BLACK, borderWidth: 0, fillSign: 'text' },
      },
    });
    finishPlacing();
    return;
  }
  const spec = itemSpec(placement, at);
  if (!spec) return;
  const ref = await createAnnotation(page.pageId, spec, { select: false });
  finishPlacing();
  if (ref) select(ref, { inspector: false });
}

/** Signs a signature field: the image is fitted inside the field box. */
export async function signInto(widget: FormWidget, item: StoredSignItem) {
  const rect = fitInside(item.width / item.height, widget.rect);
  const ref = await createAnnotation(
    widget.pageId,
    { type: 'Stamp', rect, image: base64ToBytes(item.png), contents: 'Signature', fillSign: 'signature' },
    { select: false },
  );
  if (ref) select(ref, { inspector: false });
}

/** Default Fill & Sign tool: fill fields, select, move and resize placed items. */
export function FillSignSelectOverlay({ page }: { page: EditPage }) {
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={(a) => !!a.fillSign}
      underlay={<FormsLayer page={page} onSignField={(w) => signField(w)} />}
    />
  );
}

/** Places the chosen item where the page is clicked; a ghost follows the pointer. */
export function PlaceOverlay({ page }: { page: EditPage }) {
  const placement = usePlacing((s) => s.placement);
  const [hover, setHover] = useState<Point | null>(null);
  if (!placement) return null;
  const [pw, ph] = pageSize(page);
  let ghost: Rect | null = null;
  if (hover) {
    if (placement.item) {
      const [w, h] = imageSize(placement.item, placement.kind);
      ghost = [hover[0] - w / 2, hover[1] - h / 2, hover[0] + w / 2, hover[1] + h / 2];
    } else if (placement.kind === 'text' || placement.kind === 'date') {
      const [w, h] = fitText(placement.kind === 'date' ? formatToday() : 'Text', TEXT_SIZE, 0);
      ghost = [hover[0], hover[1] - h / 2, hover[0] + w, hover[1] + h / 2];
    } else ghost = [hover[0] - 6, hover[1] - 6, hover[0] + 6, hover[1] + 6];
    ghost = [Math.max(0, ghost[0]), Math.max(0, ghost[1]), Math.min(pw, ghost[2]), Math.min(ph, ghost[3])];
  }
  return (
    <AnnotLayer
      page={page}
      capture
      selectable={() => false}
      onHover={setHover}
      onBackgroundUp={(p) => void placeAt(page, placement, p)}
    >
      {ghost && (
        <div className="annot-ghost-image fill-sign-ghost" style={pctRect(page, ghost)}>
          {placement.item ? (
            <img src={`data:image/png;base64,${placement.item.png}`} alt="" />
          ) : placement.kind === 'tick' ? (
            <Check size={14} />
          ) : placement.kind === 'cross' ? (
            <X size={14} />
          ) : placement.kind === 'dot' ? (
            <Dot size={14} />
          ) : (
            <span>{placement.kind === 'date' ? formatToday() : 'Text'}</span>
          )}
        </div>
      )}
    </AnnotLayer>
  );
}
