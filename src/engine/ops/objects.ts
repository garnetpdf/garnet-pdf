import * as mupdf from 'mupdf';
import {
  convertInlineImage, cropImage, deleteObjects, expandSimpleForm, flattenObjects, inlineImageConversionReason, insertImage, interpretPage, reorderObjects, simpleFormExpansionReason,
  replaceImage, setFillColor, setOpacity, setStrokeColor, setStrokeWidth, transformObjects,
  type Matrix, type PageObject, type RGB,
} from '@garnet/pdf-content';
import type { EngineContext } from '../context';
import type { OpResult, PageId, Rect } from '../../shared/engine-api';

interface PageArg { docId: string; pageId: PageId }
type EditAction =
  | { type: 'transform'; ids: string[]; matrix: Matrix }
  | { type: 'transformMany'; transforms: { id: string; matrix: Matrix }[] }
  | { type: 'delete'; ids: string[] }
  | { type: 'fill' | 'stroke'; ids: string[]; color: RGB }
  | { type: 'opacity'; ids: string[]; alpha: number }
  | { type: 'strokeWidth'; ids: string[]; width: number }
  | { type: 'expandForm'; id: string }
  | { type: 'reorder'; ids: string[]; direction: 'front' | 'forward' | 'backward' | 'back' }
  | { type: 'replace'; id: string; bytes: ArrayBuffer; fit: 'stretch' | 'contain' | 'cover'; allUses?: boolean }
  | { type: 'crop'; id: string; clip: Rect }
  | { type: 'insert'; bytes: ArrayBuffer; rect: Rect };
export type ObjectsEditAction = EditAction;
export interface ObjectsEditResult extends OpResult { newIds: Record<string, string[]>; selectedIds: string[] }
export interface ExtractResult { bytes: ArrayBuffer; mime: 'image/jpeg' | 'image/jp2' | 'image/png'; filename: string }
export interface InspectObject {
  id: string; kind: PageObject['kind']; bbox: Rect; pageBBox: Rect; renderBBox: Rect; ctm: Matrix; z: number;
  formPath: string[]; clipBBox?: Rect; childrenIds?: string[];
  editability: PageObject['editability']; fill?: RGB; stroke?: RGB; lineWidth?: number;
  opacity?: { fill: number; stroke: number }; paint?: { fill: boolean; stroke: boolean; evenOdd: boolean };
  editForm?: { enabled: boolean; reason?: string };
  image?: { width: number; height: number; hasSMask: boolean; hasMask: boolean; isMask: boolean; replaceRequiresAlpha: boolean; filter: string[] };
}
export interface InspectResult { revision: number; contentRevision: string; userToPage: Matrix; objects: InspectObject[]; warnings: string[] }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'objects.edit': { args: PageArg & { action: EditAction }; result: ObjectsEditResult };
    'objects.extract': { args: PageArg & { id: string }; result: ExtractResult };
    'objects.inspect': { args: PageArg; result: InspectResult };
  }
}

function imageObject(pdf: mupdf.PDFDocument, page: number, id: string): PageObject {
  const object = flattenObjects(interpretPage(pdf, page).objects).find(o => o.id === id);
  if (!object) throw new Error('Image selection is stale. Select it again.');
  if (object.kind !== 'image') throw new Error('Extract requires an image XObject.');
  return object;
}

function rawFilter(ref: mupdf.PDFObject): string[] {
  const filter = ref.get('Filter');
  if (filter.isName()) return [filter.asName()];
  if (filter.isArray()) return Array.from({ length: filter.length }, (_, i) => filter.get(i).asName());
  return [];
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer; }

function inspectObject(object: PageObject, inlineReason?: string | null, formReason?: string | null, hasMask = false): InspectObject {
  const item: InspectObject = {
    id: object.id, kind: object.kind, bbox: object.bbox, pageBBox: object.pageBBox,
    renderBBox: object.renderBBox, ctm: object.ctm, z: object.z, formPath: object.formPath,
    editability: object.editability,
  };
  if (object.kind === 'inline-image') item.editability = {
    ...object.editability, move: object.editability.move && !inlineReason, replace: object.editability.replace && !inlineReason,
    crop: object.editability.crop && !inlineReason, opacity: object.editability.opacity && !inlineReason,
    recolor: false, reorder: false,
    reason: inlineReason ?? (object.editability.move ? 'Editing converts this inline image to a separate image object.' : object.editability.reason),
  };
  if (object.clipBBox) item.clipBBox = object.clipBBox;
  if (object.opacity) item.opacity = object.opacity;
  if (object.kind === 'path' || object.kind === 'text') {
    if (object.fill) item.fill = object.fill;
    if (object.stroke) item.stroke = object.stroke;
    if (object.kind === 'path') { item.lineWidth = object.lineWidth; item.paint = object.paint; }
  }
  if (object.kind === 'image') {
    item.image = { width: object.width, height: object.height, hasSMask: object.hasSMask, hasMask, isMask: object.isMask,
      replaceRequiresAlpha: object.hasSMask || hasMask, filter: object.filter };
    if (object.isMask) item.editability = { ...object.editability, replace: false, reason: 'Stencil image replacement cannot preserve its painted colour safely.' };
  }
  if (object.kind === 'form') item.childrenIds = flattenObjects(object.children).map(child => child.id);
  if (object.kind === 'form') item.editForm = { enabled: !formReason, reason: formReason ?? undefined };
  return item;
}

function extract(pdf: mupdf.PDFDocument, page: number, id: string): ExtractResult {
  const object = imageObject(pdf, page, id);
  if (object.kind !== 'image') throw new Error('Extract requires an image XObject.');
  const ref = pdf.newIndirect(object.objNum);
  try {
    const filters = rawFilter(ref);
    const hasMask = !ref.get('SMask').isNull() || !ref.get('Mask').isNull();
    if (!hasMask && filters.length === 1 && (filters[0] === 'DCTDecode' || filters[0] === 'JPXDecode')) {
      const mime = filters[0] === 'DCTDecode' ? 'image/jpeg' : 'image/jp2';
      const stream = ref.readRawStream();
      try { return { bytes: copyBuffer(stream.asUint8Array()), mime, filename: `image-${object.objNum}.${mime === 'image/jpeg' ? 'jpg' : 'jp2'}` }; }
      finally { stream.destroy(); }
    }
    const image = pdf.loadImage(ref);
    try {
    const pixmap = image.toPixmap();
    try {
      const rgb = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
      try {
        const softMask = ref.get('SMask');
        if (!softMask.isNull()) {
          const maskImage = pdf.loadImage(softMask);
          try {
            const mask = maskImage.toPixmap();
            try {
              const rgba = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, rgb.getWidth(), rgb.getHeight()], true);
              try {
                const src = rgb.getPixels(), matte = mask.getPixels(), dst = rgba.getPixels();
                const srcChannels = rgb.getNumberOfComponents(), maskChannels = mask.getNumberOfComponents();
                for (let y = 0; y < rgb.getHeight(); y++) for (let x = 0; x < rgb.getWidth(); x++) {
                  const srcOffset = (y * rgb.getWidth() + x) * srcChannels;
                  const maskX = Math.min(mask.getWidth() - 1, Math.floor(x * mask.getWidth() / rgb.getWidth()));
                  const maskY = Math.min(mask.getHeight() - 1, Math.floor(y * mask.getHeight() / rgb.getHeight()));
                  const maskOffset = (maskY * mask.getWidth() + maskX) * maskChannels;
                  const dstOffset = (y * rgb.getWidth() + x) * 4;
                  dst[dstOffset] = src[srcOffset]; dst[dstOffset + 1] = src[srcOffset + 1]; dst[dstOffset + 2] = src[srcOffset + 2];
                  dst[dstOffset + 3] = matte[maskOffset];
                }
                return { bytes: copyBuffer(rgba.asPNG()), mime: 'image/png', filename: `image-${object.objNum}.png` };
              } finally { rgba.destroy(); }
            } finally { mask.destroy(); }
          } finally { maskImage.destroy(); }
        }
        if (!ref.get('Mask').isNull()) throw new Error('Extract with a color-key or image mask is not supported safely.');
        return { bytes: copyBuffer(rgb.asPNG()), mime: 'image/png', filename: `image-${object.objNum}.png` };
      }
      finally { rgb.destroy(); }
    } finally { pixmap.destroy(); }
    } finally { image.destroy(); }
  } finally { ref.destroy(); }
}

function guardReplacement(pdf: mupdf.PDFDocument, page: number, id: string, bytes: ArrayBuffer): void {
  const object = flattenObjects(interpretPage(pdf, page).objects).find(o => o.id === id);
  if (!object) throw new Error('Image selection is stale. Select it again.');
  if (object.kind === 'inline-image') return;
  if (object.kind !== 'image') throw new Error('Replace requires an image.');
  if (object.isMask) throw new Error('Stencil image replacement cannot preserve its painted colour safely.');
  const ref = pdf.newIndirect(object.objNum);
  try {
    if (ref.get('SMask').isNull() && ref.get('Mask').isNull()) return;
    const replacement = new mupdf.Image(new Uint8Array(bytes));
    try {
      const mask = replacement.getMask();
      try {
        if (!mask) {
          const pixmap = replacement.toPixmap();
          try { if (!pixmap.getAlpha()) throw new Error('This image uses transparency. Choose a replacement with an alpha channel to preserve it.'); }
          finally { pixmap.destroy(); }
        }
      } finally { mask?.destroy(); }
    } finally { replacement.destroy(); }
  } finally { ref.destroy(); }
}

function label(action: EditAction): string {
  switch (action.type) {
    case 'transform': case 'transformMany': return 'Transform objects';
    case 'delete': return 'Delete objects';
    case 'fill': case 'stroke': return 'Recolor objects';
    case 'opacity': return 'Change opacity';
    case 'strokeWidth': return 'Change stroke width';
    case 'expandForm': return 'Edit form contents';
    case 'reorder': return 'Reorder objects';
    case 'replace': return 'Replace image';
    case 'crop': return 'Crop image';
    case 'insert': return 'Add image';
  }
}

export const namespace = 'objects';
export const ops = {
  'objects.edit': (ctx: EngineContext, args: PageArg & { action: EditAction }): ObjectsEditResult => {
    const index = ctx.pageIndex(args.docId, args.pageId);
    const action = args.action;
    if (action.type === 'replace') guardReplacement(ctx.get(args.docId).pdf, index, action.id, action.bytes);
    let newIds: Record<string, string[]> = {};
    let selectedIds: string[] = [];
    const changed = action.type === 'replace' && action.allUses ? 'all' as const : [args.pageId];
    const result = ctx.mutate(args.docId, label(action), changed, pdf => {
      const targets = action.type === 'insert' ? [] : action.type === 'transformMany' ? action.transforms.map(x => x.id)
        : 'ids' in action ? action.ids : [action.id];
      if (action.type === 'expandForm') {
        const prior = interpretPage(pdf, index);
        const expanded = expandSimpleForm(pdf, index, action.id);
        const oldIds = new Set(flattenObjects(prior.objects).map(o => o.id));
        const mapped = new Set(Object.entries(expanded.newIds).filter(([old]) => old !== action.id && oldIds.has(old)).flatMap(([, ids]) => ids));
        selectedIds = expanded.model.objects.filter(o => !mapped.has(o.id) && o.kind !== 'form').map(o => o.id);
        newIds = { ...expanded.newIds, [action.id]: selectedIds };
        return;
      }
      const originals = Object.fromEntries(targets.map(id => [id, id]));
      if (action.type !== 'delete' && action.type !== 'reorder' && action.type !== 'fill' && action.type !== 'stroke' && action.type !== 'strokeWidth') {
        // The page is read once, and again only after an inline image has been converted (which changes it).
        // Reading it for every selected object made moving a multiple selection on a busy page very slow.
        const firstById = (model: ReturnType<typeof interpretPage>) => {
          const map = new Map<string, PageObject>();
          for (const o of flattenObjects(model.objects)) if (!map.has(o.id)) map.set(o.id, o);
          return map;
        };
        let objectsById = firstById(interpretPage(pdf, index));
        for (const original of targets) {
          const current = originals[original];
          const object = objectsById.get(current);
          if (object?.kind !== 'inline-image') continue;
          const promoted = convertInlineImage(pdf, index, current);
          for (const [old, now] of Object.entries(originals)) originals[old] = promoted.newIds[now]?.[0] ?? now;
          objectsById = firstById(promoted.model);
        }
      }
      if (action.type === 'transformMany') {
        const originalIds = action.transforms.map(x => x.id);
        if (new Set(originalIds).size !== originalIds.length) throw new Error('Duplicate object transform.');
        let current = { ...originals };
        for (const item of action.transforms) {
          const id = current[item.id];
          const next = transformObjects(pdf, index, [id], item.matrix);
          current = Object.fromEntries(Object.entries(current).map(([old, mapped]) => [old, next.newIds[mapped]?.[0] ?? mapped]));
        }
        newIds = Object.fromEntries(Object.entries(current).map(([old, now]) => [old, [now]]));
        selectedIds = Object.values(current);
        return;
      }
      const currentIds = targets.map(id => originals[id]);
      const edit = action.type === 'transform' ? transformObjects(pdf, index, currentIds, action.matrix)
        : action.type === 'delete' ? deleteObjects(pdf, index, currentIds)
        : (action.type === 'fill' || action.type === 'stroke') ? (action.type === 'fill' ? setFillColor(pdf, index, currentIds, action.color) : setStrokeColor(pdf, index, currentIds, action.color))
        : action.type === 'opacity' ? setOpacity(pdf, index, currentIds, action.alpha)
        : action.type === 'strokeWidth' ? setStrokeWidth(pdf, index, currentIds, action.width)
        : action.type === 'reorder' ? reorderObjects(pdf, index, currentIds, action.direction)
        : action.type === 'replace' ? replaceImage(pdf, index, originals[action.id], new Uint8Array(action.bytes), action.fit, action.allUses)
        : action.type === 'crop' ? cropImage(pdf, index, originals[action.id], action.clip)
        : action.type === 'insert' ? insertImage(pdf, index, new Uint8Array(action.bytes), action.rect)
        : (() => { throw new Error('Unknown object action.'); })();
      newIds = Object.fromEntries(targets.map(id => [id, edit.newIds[originals[id]] ?? []]));
      const ids: string[] = action.type === 'insert' ? ('id' in edit ? [String(edit.id)] : [])
        : 'ids' in action ? action.ids
        : [action.id];
      selectedIds = action.type === 'insert' ? ids : ids.flatMap(id => newIds[id] ?? []);
    });
    return { ...result, newIds, selectedIds };
  },
  'objects.extract': (ctx: EngineContext, args: PageArg & { id: string }): ExtractResult => {
    const doc = ctx.get(args.docId);
    return extract(doc.pdf, ctx.pageIndex(args.docId, args.pageId), args.id);
  },
  'objects.inspect': (ctx: EngineContext, args: PageArg): InspectResult => {
    const doc = ctx.get(args.docId);
    const model = interpretPage(doc.pdf, ctx.pageIndex(args.docId, args.pageId));
    return { revision: doc.revision, contentRevision: model.revision, userToPage: model.userToPage,
      objects: model.objects.map(o => {
        let hasMask = false;
        if (o.kind === 'image') {
          const ref = doc.pdf.newIndirect(o.objNum);
          try { hasMask = !ref.get('Mask').isNull(); } finally { ref.destroy(); }
        }
        // One unreadable picture or form must not hide every other object on the page: it is listed as it is,
        // with the reason it cannot be converted or opened.
        const reason = (read: () => string | null): string | null => {
          try {
            return read();
          } catch (error) {
            return `This object cannot be read (${String((error as Error)?.message ?? error).slice(0, 80)})`;
          }
        };
        return inspectObject(o, o.kind === 'inline-image' ? reason(() => inlineImageConversionReason(model, o.id)) : null,
          o.kind === 'form' ? reason(() => simpleFormExpansionReason(doc.pdf, model, o.id)) : null, hasMask);
      }), warnings: model.warnings };
  },
};
