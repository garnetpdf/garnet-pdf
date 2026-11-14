/**
 * Page stamps: headers and footers (page numbers, dates, file names, Bates numbers), watermarks
 * (text or image) and background colour. Each stamp is a form XObject per page, drawn from its
 * own content stream inside `/Artifact` marked content, so text extraction and screen readers
 * treat it as pagination, and it can be listed, updated and removed exactly:
 *  - the form carries `/GarnetStamp << /Kind ... /Id (...) /Spec ... >>` (private keys);
 *  - the page content streams added by a stamp carry `/GarnetStampRole` in their dictionaries;
 *  - original page content streams are never modified. Front stamps are separated from the
 *    original content by a guard pair (q ... Q) computed from the original's q/Q balance, so they
 *    always draw in the default page coordinate system.
 * Removing every stamp leaves the original content streams, in their original order.
 */
import * as mupdf from 'mupdf';
import { parseContent } from '@garnet/pdf-content';
import { FontBook, drawLine, type FontFamily, type FontUse } from './text';
import { contentStreams, cropBox, fmt, matrixString, mediaBox, newArrayOf, pageRotation, str, visualSize, visualToPage, type Doc, type Obj } from './pdf';
import { FONT_TAG, freshImage } from './resources';

export type HeaderSlot = 'topLeft' | 'topCenter' | 'topRight' | 'bottomLeft' | 'bottomCenter' | 'bottomRight';
export const HEADER_SLOTS: HeaderSlot[] = ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight'];
export type RGB = [number, number, number];

export interface HeaderFooterSpec {
  kind: 'header-footer';
  texts: Partial<Record<HeaderSlot, string>>;
  font: FontFamily;
  size: number;
  color: RGB;
  bold?: boolean;
  italic?: boolean;
  /** Distance from the visible page edges, points. */
  margins: { top: number; bottom: number; left: number; right: number };
  /** Number shown by {page} on the first stamped page. Default 1. */
  startNumber?: number;
  bates?: { prefix?: string; suffix?: string; start: number; digits: number };
  /** Text for {date}, formatted by the caller. */
  dateText?: string;
  /** Text for {filename}. */
  fileName?: string;
  direction?: 'auto' | 'ltr' | 'rtl';
}

export interface WatermarkSpec {
  kind: 'watermark';
  text?: string;
  /** PNG or JPEG bytes (not stored in the stamp description). */
  image?: ArrayBuffer;
  font?: FontFamily;
  bold?: boolean;
  /** Text size in points. */
  size?: number;
  color?: RGB;
  opacity: number;
  /** Degrees, counterclockwise. */
  rotation: number;
  /** Image width as a share of the visible page width (0.05 to 1). */
  scale?: number;
  /** Centre as a share of the visible page (0 to 1, from the bottom-left). Default 0.5, 0.5. */
  position?: { x: number; y: number };
  behind: boolean;
}

export interface BackgroundSpec {
  kind: 'background';
  color: RGB;
  opacity?: number;
}

export type StampSpec = HeaderFooterSpec | WatermarkSpec | BackgroundSpec;

export interface StampInfo {
  id: string;
  kind: StampSpec['kind'];
  spec: Omit<StampSpec, 'image'> & { hasImage?: boolean };
  pageCount: number;
}

const KIND_NAME: Record<StampSpec['kind'], string> = { 'header-footer': 'HeaderFooter', watermark: 'Watermark', background: 'Background' };
const NAME_KIND: Record<string, StampSpec['kind']> = { HeaderFooter: 'header-footer', Watermark: 'watermark', Background: 'background' };
const PREFIX = 'GarnetStamp_';

export interface TokenValues { page: number; pages: number; label: string; date: string; filename: string; bates: string }

export function expandTokens(template: string, values: TokenValues): string {
  return template.replace(/\{(page|pages|label|date|filename|bates)\}/g, (_, token: keyof TokenValues) => String(values[token]));
}

export function batesNumber(bates: HeaderFooterSpec['bates'], k: number): string {
  if (!bates) return '';
  const digits = Math.max(1, Math.min(12, Math.trunc(bates.digits) || 6));
  return `${bates.prefix ?? ''}${String(Math.trunc(bates.start) + k).padStart(digits, '0')}${bates.suffix ?? ''}`;
}

function validColor(color: RGB | undefined): RGB {
  const c = color ?? [0, 0, 0];
  if (c.length !== 3 || !c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Colour values must be between 0 and 1.');
  return c;
}

export function validateSpec(spec: StampSpec): void {
  if (spec.kind === 'header-footer') {
    if (!(spec.size >= 4 && spec.size <= 96)) throw new Error('Text size must be between 4 and 96 points.');
    validColor(spec.color);
    for (const value of Object.values(spec.margins)) if (!Number.isFinite(value) || value < 0 || value > 400) throw new Error('Margins must be between 0 and 400 points.');
    if (!HEADER_SLOTS.some((slot) => spec.texts[slot]?.trim())) throw new Error('Type the header or footer text.');
  } else if (spec.kind === 'watermark') {
    if (!spec.text?.trim() && !spec.image) throw new Error('Type the watermark text or choose an image.');
    if (!(spec.opacity > 0 && spec.opacity <= 1)) throw new Error('Opacity must be between 1% and 100%.');
    if (!Number.isFinite(spec.rotation)) throw new Error('Rotation must be a number.');
    if (spec.size !== undefined && !(spec.size >= 4 && spec.size <= 500)) throw new Error('Text size must be between 4 and 500 points.');
    if (spec.scale !== undefined && !(spec.scale >= 0.05 && spec.scale <= 1)) throw new Error('Image size must be between 5% and 100% of the page width.');
    validColor(spec.color);
  } else {
    validColor(spec.color);
    if (spec.opacity !== undefined && !(spec.opacity > 0 && spec.opacity <= 1)) throw new Error('Opacity must be between 1% and 100%.');
  }
}

function balanceOf(streams: readonly Obj[]): { guards: number; depth: number; inText: boolean } {
  let depth = 0, min = 0, inText = false;
  try {
    for (const stream of streams) {
      if (!stream.isStream()) continue;
      const buffer = stream.readStream();
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(buffer.asUint8Array()); } finally { buffer.destroy(); }
      for (const op of parseContent(bytes).operations) {
        if (op.operator === 'q') depth++;
        else if (op.operator === 'Q') { depth--; if (depth < min) min = depth; }
        else if (op.operator === 'BT') inText = true;
        else if (op.operator === 'ET') inText = false;
      }
    }
  } catch {
    return { guards: 4, depth: 0, inText: false };
  }
  return { guards: -min, depth, inText };
}

/** Rebuilds /Contents as [behind stamps, guard, original..., close, front stamps]. */
function rebuildContents(pdf: Doc, page: Obj, removeIds: ReadonlySet<string> | null, add?: { stream: Obj; behind: boolean }): void {
  const behind: Obj[] = [], front: Obj[] = [], original: Obj[] = [];
  let changed = Boolean(add);
  for (const stream of contentStreams(page)) {
    const role = stream.get('GarnetStampRole');
    if (!role.isName()) { original.push(stream); continue; }
    const name = role.asName();
    if (name === 'Guard' || name === 'Close') { changed = true; continue; }
    if (removeIds && removeIds.has(str(stream.get('GarnetStamp')))) { changed = true; continue; }
    (name === 'Behind' ? behind : front).push(stream);
  }
  if (!changed) return;
  if (add) (add.behind ? behind : front).push(add.stream);
  const list: Obj[] = [...behind];
  if (front.length) {
    const { guards, depth, inText } = balanceOf(original);
    const guard = pdf.addStream('q\n'.repeat(1 + guards), { GarnetStampRole: pdf.newName('Guard') });
    const close = pdf.addStream(`${inText ? 'ET\n' : ''}${'Q\n'.repeat(Math.max(0, 1 + guards + depth))}`, { GarnetStampRole: pdf.newName('Close') });
    list.push(guard, ...original, close, ...front);
  } else list.push(...original);
  if (list.length === 1) page.put('Contents', list[0]);
  else {
    const array = pdf.newArray();
    list.forEach((s) => array.push(s));
    page.put('Contents', array);
  }
}

/** The page's own direct /Resources (copying inherited or shared dictionaries first). */
function ownResources(pdf: Doc, page: Obj): Obj {
  const own = page.get('Resources');
  if (own.isDictionary() && !own.isIndirect()) return own;
  const inherited = page.getInheritable('Resources');
  const copy = pdf.newDictionary();
  if (inherited.isDictionary()) {
    inherited.forEach((value, key) => {
      if (!value.isIndirect() && value.isDictionary()) {
        const sub = pdf.newDictionary();
        value.forEach((v, k) => sub.put(k, v));
        copy.put(key, sub);
      } else copy.put(key, value);
    });
  }
  page.put('Resources', copy);
  return page.get('Resources');
}

function ownXObjects(pdf: Doc, resources: Obj): Obj {
  const current = resources.get('XObject');
  if (current.isDictionary() && !current.isIndirect()) return current;
  const copy = pdf.newDictionary();
  if (current.isDictionary()) current.forEach((v, k) => copy.put(k, v));
  resources.put('XObject', copy);
  return resources.get('XObject');
}

export interface StampContext {
  labels: string[];
  fonts: FontBook;
  /** For a preview of one page: its position among the target pages and their count. */
  numbering?: { position: number; count: number };
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Applies one stamp to the given pages (zero-based indices, in stamping order). */
export function applyStamp(pdf: Doc, indices: readonly number[], spec: StampSpec, context: StampContext, id = newId()): string {
  validateSpec(spec);
  const { image, ...stored } = spec as WatermarkSpec;
  const description = pdf.addObject(pdf.newDictionary());
  description.put('Json', pdf.newString(JSON.stringify({ ...stored, hasImage: Boolean(image) || undefined })));
  let imageRef: Obj | null = null, imageSize: [number, number] = [1, 1];
  if (spec.kind === 'watermark' && image) {
    const img = new mupdf.Image(new Uint8Array(image));
    try {
      imageRef = freshImage(pdf, img);
      imageSize = [img.getWidth(), img.getHeight()];
    } finally {
      img.destroy();
    }
  }
  const stampedPages = context.numbering?.count ?? indices.length;
  const name = `${PREFIX}${id}`;
  let live: Map<string, Obj> | undefined;
  const liveFonts = () => (live ??= liveStampFonts(pdf));
  indices.forEach((index, k) => {
    const page = pdf.findPage(index);
    const rotation = pageRotation(page);
    const box = cropBox(page);
    const [vw, vh] = visualSize(page);
    const fonts = pdf.newDictionary();
    const fontNames = new Map<string, string>();
    const fontName = (use: FontUse) => {
      let key = fontNames.get(use.key);
      if (!key) {
        key = `F${fontNames.size}`;
        fontNames.set(use.key, key);
        fonts.put(key, context.fonts.ref(pdf, use, liveFonts));
      }
      return key;
    };
    const resources = pdf.newDictionary();
    let body = '';
    let artifact = '<</Type /Pagination>>';
    let behind = false;
    if (spec.kind === 'header-footer') {
      const start = Math.trunc(spec.startNumber ?? 1);
      const position = (context.numbering?.position ?? 0) + k;
      const values: TokenValues = { page: start + position, pages: start + stampedPages - 1, label: context.labels[index] ?? String(index + 1), date: spec.dateText ?? '', filename: spec.fileName ?? '', bates: batesNumber(spec.bates, position) };
      const color = validColor(spec.color);
      const used = HEADER_SLOTS.filter((slot) => spec.texts[slot]?.trim());
      const subtype = used.every((s) => s.startsWith('top')) ? ' /Subtype /Header' : used.every((s) => s.startsWith('bottom')) ? ' /Subtype /Footer' : '';
      artifact = `<</Type /Pagination${subtype}>>`;
      body += `${color.map(fmt).join(' ')} rg\n`;
      for (const slot of used) {
        const text = expandTokens(spec.texts[slot]!, values);
        const layout = context.fonts.layout(text, spec.font, spec.size, { bold: spec.bold, italic: spec.italic, direction: spec.direction });
        const x = slot.endsWith('Left') ? spec.margins.left : slot.endsWith('Right') ? vw - spec.margins.right - layout.width : (vw - layout.width) / 2;
        const y = slot.startsWith('top') ? vh - spec.margins.top - layout.ascent : spec.margins.bottom + layout.descent;
        body += drawLine(layout, x, y, spec.size, fontName);
      }
    } else if (spec.kind === 'watermark') {
      behind = spec.behind;
      artifact = '<</Type /Pagination /Subtype /Watermark>>';
      const gs = pdf.newDictionary();
      const state = pdf.newDictionary();
      state.put('Type', pdf.newName('ExtGState'));
      state.put('ca', spec.opacity);
      state.put('CA', spec.opacity);
      gs.put('GS0', state);
      resources.put('ExtGState', gs);
      const cx = (spec.position?.x ?? 0.5) * vw, cy = (spec.position?.y ?? 0.5) * vh;
      const angle = (spec.rotation * Math.PI) / 180;
      const turn = matrixString([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), cx, cy]);
      body += `/GS0 gs\n`;
      if (imageRef) {
        const w = (spec.scale ?? 0.5) * vw, h = (w * imageSize[1]) / imageSize[0];
        const xobjects = pdf.newDictionary();
        xobjects.put('Im0', imageRef);
        resources.put('XObject', xobjects);
        body += `q ${turn} cm ${fmt(w)} 0 0 ${fmt(h)} ${fmt(-w / 2)} ${fmt(-h / 2)} cm /Im0 Do Q\n`;
      }
      if (spec.text?.trim()) {
        const size = spec.size ?? 72;
        const layout = context.fonts.layout(spec.text, spec.font ?? 'Helvetica', size, { bold: spec.bold });
        body += `q ${turn} cm ${validColor(spec.color ?? [0.5, 0.5, 0.5]).map(fmt).join(' ')} rg\n`;
        body += drawLine(layout, -layout.width / 2, -(layout.ascent - layout.descent) / 2, size, fontName);
        body += 'Q\n';
      }
    } else {
      behind = true;
      artifact = '<</Type /Background>>';
      if (spec.opacity !== undefined && spec.opacity < 1) {
        const gs = pdf.newDictionary();
        const state = pdf.newDictionary();
        state.put('Type', pdf.newName('ExtGState'));
        state.put('ca', spec.opacity);
        gs.put('GS0', state);
        resources.put('ExtGState', gs);
        body += '/GS0 gs\n';
      }
      body += `${validColor(spec.color).map(fmt).join(' ')} rg 0 0 ${fmt(vw)} ${fmt(vh)} re f\n`;
    }
    if (fontNames.size) resources.put('Font', fonts);
    const marker = pdf.newDictionary();
    marker.put('Kind', pdf.newName(KIND_NAME[spec.kind]));
    marker.put('Id', pdf.newString(id));
    marker.put('Spec', description);
    const form = pdf.addStream(`q ${matrixString(visualToPage(rotation, box))} cm\n${body}Q\n`, {
      Type: pdf.newName('XObject'),
      Subtype: pdf.newName('Form'),
      BBox: newArrayOf(pdf, mediaBox(page)),
      Resources: resources,
      GarnetStamp: marker,
    });
    const xobjects = ownXObjects(pdf, ownResources(pdf, page));
    xobjects.put(name, form);
    const stream = pdf.addStream(`q /Artifact ${artifact} BDC /${name} Do EMC Q\n`, { GarnetStamp: pdf.newString(id), GarnetStampRole: pdf.newName(behind ? 'Behind' : 'Front') });
    rebuildContents(pdf, page, null, { stream, behind });
  });
  return id;
}

/** Removes stamps by id (or every stamp of a kind, or all) from the given pages. Returns the
 * number of pages changed. */
export function removeStamps(pdf: Doc, indices: readonly number[], filter: { ids?: string[]; kind?: StampSpec['kind'] }): number {
  let changed = 0;
  for (const index of indices) {
    const page = pdf.findPage(index);
    const resources = page.get('Resources');
    const xobjects = resources.isDictionary() ? resources.get('XObject') : null;
    const remove = new Set<string>();
    const names: string[] = [];
    if (xobjects && xobjects.isDictionary()) {
      xobjects.forEach((value, key) => {
        const name = String(key);
        if (!name.startsWith(PREFIX)) return;
        const marker = value.get('GarnetStamp');
        if (!marker.isDictionary()) return;
        const id = str(marker.get('Id'));
        const kind = NAME_KIND[str(marker.get('Kind'))];
        if ((filter.ids && !filter.ids.includes(id)) || (filter.kind && filter.kind !== kind)) return;
        remove.add(id);
        names.push(name);
      });
    }
    if (!remove.size) continue;
    names.forEach((name) => xobjects!.delete(name));
    rebuildContents(pdf, page, remove);
    changed++;
  }
  return changed;
}

/** Fonts used by stamps still on the pages, by tag; reachable objects survive undo, unlike MuPDF's tables. */
function liveStampFonts(pdf: Doc): Map<string, Obj> {
  const found = new Map<string, Obj>();
  for (let i = 0; i < pdf.countPages(); i++) {
    const resources = pdf.findPage(i).get('Resources');
    if (!resources.isDictionary()) continue;
    const xobjects = resources.get('XObject');
    if (!xobjects.isDictionary()) continue;
    xobjects.forEach((form, key) => {
      if (!String(key).startsWith(PREFIX)) return;
      const formResources = form.get('Resources');
      if (!formResources.isDictionary()) return;
      const fonts = formResources.get('Font');
      if (!fonts.isDictionary()) return;
      fonts.forEach((font) => {
        const tag = font.get(FONT_TAG);
        if (tag.isString() && font.isIndirect() && !found.has(tag.asString())) found.set(tag.asString(), font);
      });
    });
  }
  return found;
}

export function listStamps(pdf: Doc): StampInfo[] {
  const found = new Map<string, StampInfo>();
  for (let i = 0; i < pdf.countPages(); i++) {
    const page = pdf.findPage(i);
    const xobjects = page.get('Resources');
    if (!xobjects.isDictionary()) continue;
    const dict = xobjects.get('XObject');
    if (!dict.isDictionary()) continue;
    dict.forEach((value, key) => {
      if (!String(key).startsWith(PREFIX)) return;
      const marker = value.get('GarnetStamp');
      if (!marker.isDictionary()) return;
      const id = str(marker.get('Id'));
      const existing = found.get(id);
      if (existing) { existing.pageCount++; return; }
      let spec: StampInfo['spec'];
      try { spec = JSON.parse(str(marker.get('Spec').get('Json'))); } catch { spec = { kind: NAME_KIND[str(marker.get('Kind'))] ?? 'watermark' } as StampInfo['spec']; }
      found.set(id, { id, kind: NAME_KIND[str(marker.get('Kind'))] ?? spec.kind, spec, pageCount: 1 });
    });
  }
  return [...found.values()];
}

export function stampFontNeeds(spec: StampSpec): { family: FontFamily; text: string } {
  if (spec.kind === 'header-footer') return { family: spec.font, text: Object.values(spec.texts).join(' ') + (spec.fileName ?? '') + (spec.dateText ?? '') + (spec.bates?.prefix ?? '') + (spec.bates?.suffix ?? '') };
  if (spec.kind === 'watermark') return { family: spec.font ?? 'Helvetica', text: spec.text ?? '' };
  return { family: 'Helvetica', text: '' };
}
