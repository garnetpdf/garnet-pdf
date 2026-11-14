import type * as mupdf from 'mupdf';
import { parseContent, serializeContent } from '@garnet/pdf-content';

export const SANITIZE_KEYS = ['metadata', 'javascript', 'embeddedFiles', 'hiddenLayers', 'annotations', 'formActions', 'links', 'thumbnails'] as const;
export type SanitizeKey = (typeof SANITIZE_KEYS)[number];
export type SanitizeOptions = Record<SanitizeKey, boolean>;
export type SanitizeCounts = Record<SanitizeKey, number>;

export const SANITIZE_LABELS: Record<SanitizeKey, { label: string; help: string }> = {
  metadata: { label: 'Document metadata', help: 'Title, author, dates, software names and XMP data.' },
  javascript: { label: 'JavaScript and actions', help: 'Scripts, open actions, launch actions and page actions.' },
  embeddedFiles: { label: 'Attached files', help: 'Files embedded in the document or in comments.' },
  hiddenLayers: { label: 'Hidden layers', help: 'Content on layers that are switched off.' },
  annotations: { label: 'Comments and markup', help: 'Notes, highlights, drawings and stamps. Redaction marks stay.' },
  formActions: { label: 'Form actions', help: 'Submit, reset and import actions and field scripts.' },
  links: { label: 'Links', help: 'Links to web pages, files and other pages.' },
  thumbnails: { label: 'Embedded page thumbnails', help: 'Small preview images stored in the file.' },
};

const SCRIPT_ACTIONS = new Set(['JavaScript', 'Launch', 'Rendition', 'Movie', 'Sound', 'GoToE', 'GoToR', 'Hide', 'SetOCGState', 'Trans', 'GoTo3DView', 'RichMediaExecute']);
const FORM_ACTIONS = new Set(['SubmitForm', 'ResetForm', 'ImportData']);

function emptyCounts(): SanitizeCounts {
  return Object.fromEntries(SANITIZE_KEYS.map(key => [key, 0])) as SanitizeCounts;
}

function actionType(action: mupdf.PDFObject): string {
  const resolved = action.resolve();
  if (!resolved.isDictionary()) return '';
  const type = resolved.get('S');
  return type.isName() ? type.asName() : '';
}

function deleteFromArray(array: mupdf.PDFObject, remove: (item: mupdf.PDFObject) => boolean): number {
  let removed = 0;
  for (let i = array.length - 1; i >= 0; i--) {
    if (remove(array.get(i))) { array.delete(i); removed++; }
  }
  return removed;
}

function nameTreeCount(node: mupdf.PDFObject, depth = 0): number {
  const resolved = node.resolve();
  if (!resolved.isDictionary() || depth > 32) return 0;
  const names = resolved.get('Names');
  let count = names.isArray() ? Math.floor(names.length / 2) : 0;
  const kids = resolved.get('Kids');
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) count += nameTreeCount(kids.get(i), depth + 1);
  return count;
}

function ocgSet(array: mupdf.PDFObject): Set<number> {
  const set = new Set<number>();
  if (array.isArray()) for (let i = 0; i < array.length; i++) if (array.get(i).isIndirect()) set.add(array.get(i).asIndirect());
  return set;
}

/** OCGs switched off in the default configuration. */
export function hiddenLayerObjects(pdf: mupdf.PDFDocument): Set<number> {
  const props = pdf.getTrailer().get('Root').get('OCProperties');
  if (!props.isDictionary()) return new Set();
  const all = ocgSet(props.get('OCGs'));
  const config = props.get('D');
  const baseOff = config.get('BaseState').isName() && config.get('BaseState').asName() === 'OFF';
  const on = ocgSet(config.get('ON'));
  const off = ocgSet(config.get('OFF'));
  return new Set([...all].filter(num => (baseOff ? !on.has(num) : off.has(num))));
}

function isHiddenOC(oc: mupdf.PDFObject, hidden: Set<number>): boolean {
  const resolved = oc.resolve();
  if (!resolved.isDictionary()) return false;
  const type = resolved.get('Type');
  if (type.isName() && type.asName() === 'OCMD') {
    const ocgs = resolved.get('OCGs');
    const members = ocgs.isArray() ? [...ocgSet(ocgs)] : ocgs.isIndirect() ? [ocgs.asIndirect()] : [];
    if (!members.length) return false;
    const policy = resolved.get('P').isName() ? resolved.get('P').asName() : 'AnyOn';
    const hiddenCount = members.filter(num => hidden.has(num)).length;
    return policy === 'AllOn' || policy === 'AnyOff' ? hiddenCount > 0 : hiddenCount === members.length;
  }
  return oc.isIndirect() && hidden.has(oc.asIndirect());
}

function contentStreams(page: mupdf.PDFObject): mupdf.PDFObject[] {
  const contents = page.get('Contents');
  if (contents.isArray()) return Array.from({ length: contents.length }, (_, i) => contents.get(i)).filter(s => s.isStream());
  return contents.isStream() ? [contents] : [];
}

/** Removes marked content and XObjects that belong to hidden layers from one page's content streams. */
function stripHiddenContent(pdf: mupdf.PDFDocument, page: mupdf.PDFObject, hidden: Set<number>, dryRun: boolean): number {
  const resources = page.getInheritable('Resources');
  const properties = resources.get('Properties');
  const xobjects = resources.get('XObject');
  const streams = contentStreams(page);
  const stack: boolean[] = [];
  let removed = 0;
  const edits: { ref: mupdf.PDFObject; model: ReturnType<typeof parseContent> }[] = [];
  for (const ref of streams) {
    const raw = ref.readStream();
    const bytes = new Uint8Array(raw.asUint8Array());
    raw.destroy();
    const model = parseContent(bytes);
    let changed = false;
    for (const op of model.operations) {
      const inside = stack.includes(true);
      if (op.operator === 'BDC' || op.operator === 'BMC') {
        let hiddenHere = false;
        if (op.operator === 'BDC' && op.operands[0] && typeof op.operands[0] === 'object' && !Array.isArray(op.operands[0]) && op.operands[0] !== null && 'type' in op.operands[0] && op.operands[0].type === 'name' && op.operands[0].value === 'OC') {
          const property = op.operands[1];
          if (property && typeof property === 'object' && !Array.isArray(property) && 'type' in property && property.type === 'name' && properties.isDictionary())
            hiddenHere = isHiddenOC(properties.get(property.value), hidden);
        }
        stack.push(hiddenHere);
        if (hiddenHere && !inside) removed++;
        if (hiddenHere || inside) { op.replacement = new Uint8Array(); changed = true; }
        continue;
      }
      if (op.operator === 'EMC') {
        const wasHidden = stack.pop() ?? false;
        if (wasHidden || inside) { op.replacement = new Uint8Array(); changed = true; }
        continue;
      }
      if (inside) { op.replacement = new Uint8Array(); changed = true; continue; }
      if (op.operator === 'Do' && xobjects.isDictionary()) {
        const name = op.operands[0];
        if (name && typeof name === 'object' && !Array.isArray(name) && 'type' in name && name.type === 'name') {
          const xobject = xobjects.get(name.value);
          if (xobject.isStream() && isHiddenOC(xobject.get('OC'), hidden)) { op.replacement = new Uint8Array(); changed = true; removed++; }
        }
      }
    }
    if (changed) edits.push({ ref, model });
  }
  if (!dryRun) for (const { ref, model } of edits) ref.writeStream(serializeContent(model));
  void pdf;
  return removed;
}

function removeLayers(pdf: mupdf.PDFDocument, hidden: Set<number>) {
  const root = pdf.getTrailer().get('Root');
  const props = root.get('OCProperties');
  if (!props.isDictionary()) return;
  const isHidden = (item: mupdf.PDFObject) => item.isIndirect() && hidden.has(item.asIndirect());
  const prune = (array: mupdf.PDFObject) => {
    if (!array.isArray()) return;
    for (let i = array.length - 1; i >= 0; i--) {
      const item = array.get(i);
      if (isHidden(item)) array.delete(i);
      else if (item.isArray()) prune(item);
    }
  };
  prune(props.get('OCGs'));
  const configs = [props.get('D')];
  const extra = props.get('Configs');
  if (extra.isArray()) for (let i = 0; i < extra.length; i++) configs.push(extra.get(i));
  for (const config of configs) {
    if (!config.isDictionary()) continue;
    for (const key of ['ON', 'OFF', 'Order', 'Locked', 'RBGroups']) prune(config.get(key));
    const usage = config.get('AS');
    if (usage.isArray()) for (let i = 0; i < usage.length; i++) prune(usage.get(i).get('OCGs'));
  }
  if (!props.get('OCGs').isArray() || props.get('OCGs').length === 0) root.delete('OCProperties');
}

function walkFields(field: mupdf.PDFObject, visit: (field: mupdf.PDFObject) => void, depth = 0) {
  const resolved = field.resolve();
  if (!resolved.isDictionary() || depth > 32) return;
  visit(resolved);
  const kids = resolved.get('Kids');
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) walkFields(kids.get(i), visit, depth + 1);
}

/** Scans (dryRun) or removes hidden information. All edits are object-level so they join the caller's journal step. */
export function sanitizeDocument(pdf: mupdf.PDFDocument, options: SanitizeOptions, dryRun: boolean): SanitizeCounts {
  const counts = emptyCounts();
  const trailer = pdf.getTrailer();
  const root = trailer.get('Root');
  const names = root.get('Names');
  const pageCount = pdf.countPages();
  const pages = Array.from({ length: pageCount }, (_, i) => pdf.findPage(i));
  try {
    if (options.metadata) {
      // Empty the Info object rather than unlinking it: MuPDF does not journal trailer keys, so unlinking
      // could not be undone. The saved file keeps an empty Info dictionary.
      const info = trailer.get('Info');
      if (info.isDictionary()) {
        const keys: string[] = [];
        info.forEach((_value, key) => keys.push(String(key)));
        counts.metadata += keys.length;
        if (!dryRun) for (const key of keys) info.delete(key);
      }
      for (const holder of [root, ...pages]) {
        for (const key of ['Metadata', 'PieceInfo']) {
          if (!holder.get(key).isNull()) { counts.metadata++; if (!dryRun) holder.delete(key); }
        }
      }
    }
    if (options.javascript) {
      if (names.isDictionary() && !names.get('JavaScript').isNull()) {
        counts.javascript += Math.max(1, nameTreeCount(names.get('JavaScript')));
        if (!dryRun) names.delete('JavaScript');
      }
      const open = root.get('OpenAction');
      if (open.isDictionary() && SCRIPT_ACTIONS.has(actionType(open))) { counts.javascript++; if (!dryRun) root.delete('OpenAction'); }
      for (const holder of [root, ...pages]) if (!holder.get('AA').isNull()) { counts.javascript++; if (!dryRun) holder.delete('AA'); }
    }
    if (options.embeddedFiles) {
      if (names.isDictionary() && !names.get('EmbeddedFiles').isNull()) {
        counts.embeddedFiles += Math.max(1, nameTreeCount(names.get('EmbeddedFiles')));
        if (!dryRun) names.delete('EmbeddedFiles');
      }
      for (const holder of [root, ...pages]) if (!holder.get('AF').isNull()) { if (!dryRun) holder.delete('AF'); }
      if (!root.get('Collection').isNull() && !dryRun) root.delete('Collection');
    }
    const hiddenForAnnots = options.hiddenLayers ? hiddenLayerObjects(pdf) : new Set<number>();
    if (options.hiddenLayers) {
      const hidden = hiddenForAnnots;
      if (hidden.size) {
        for (const page of pages) stripHiddenContent(pdf, page, hidden, dryRun);
        counts.hiddenLayers = hidden.size;
        if (!dryRun) removeLayers(pdf, hidden);
      }
    }
    if (options.thumbnails) {
      for (const page of pages) if (!page.get('Thumb').isNull()) { counts.thumbnails++; if (!dryRun) page.delete('Thumb'); }
    }
    for (const page of pages) {
      const annots = page.get('Annots');
      if (!annots.isArray()) continue;
      const removedPopups = new Set<number>();
      const removedNums = new Set<number>();
      const willRemove = (annot: mupdf.PDFObject): SanitizeKey | null => {
        const resolved = annot.resolve();
        if (!resolved.isDictionary()) return null;
        const subtype = resolved.get('Subtype').isName() ? resolved.get('Subtype').asName() : '';
        if (options.embeddedFiles && subtype === 'FileAttachment') return 'embeddedFiles';
        if (options.links && subtype === 'Link') return 'links';
        if (options.annotations && !['Link', 'Widget', 'Popup', 'Redact'].includes(subtype)) return 'annotations';
        if (options.hiddenLayers && hiddenForAnnots.size && isHiddenOC(resolved.get('OC'), hiddenForAnnots)) return 'hiddenLayers';
        return null;
      };
      for (let i = 0; i < annots.length; i++) {
        const annot = annots.get(i);
        const reason = willRemove(annot);
        if (reason) {
          if (reason !== 'hiddenLayers') counts[reason]++;
          if (annot.isIndirect()) removedNums.add(annot.asIndirect());
          const popup = annot.resolve().get('Popup');
          if (popup.isIndirect()) removedPopups.add(popup.asIndirect());
          continue;
        }
        const resolved = annot.resolve();
        const subtype = resolved.get('Subtype').isName() ? resolved.get('Subtype').asName() : '';
        if (options.javascript || options.formActions) {
          const action = resolved.get('A');
          const type = action.isNull() ? '' : actionType(action);
          const isForm = FORM_ACTIONS.has(type) || (subtype === 'Widget' && type === 'JavaScript');
          if (type && ((options.formActions && isForm) || (options.javascript && !isForm && SCRIPT_ACTIONS.has(type)))) {
            counts[isForm ? 'formActions' : 'javascript']++;
            if (!dryRun) resolved.delete('A');
          }
          if (!resolved.get('AA').isNull()) {
            const key: SanitizeKey = subtype === 'Widget' ? 'formActions' : 'javascript';
            if (options[key]) { counts[key]++; if (!dryRun) resolved.delete('AA'); }
          }
        }
      }
      if (!dryRun && (removedNums.size || removedPopups.size)) {
        deleteFromArray(annots, item => {
          if (!item.isIndirect()) return Boolean(willRemove(item));
          const num = item.asIndirect();
          if (removedNums.has(num) || removedPopups.has(num)) return true;
          const parent = item.resolve().get('Parent');
          return parent.isIndirect() && removedNums.has(parent.asIndirect());
        });
      }
    }
    if (options.formActions) {
      const form = root.get('AcroForm');
      if (form.isDictionary()) {
        const fields = form.get('Fields');
        if (fields.isArray()) for (let i = 0; i < fields.length; i++) walkFields(fields.get(i), field => {
          if (!field.get('AA').isNull()) { counts.formActions++; if (!dryRun) field.delete('AA'); }
          const action = field.get('A');
          if (!action.isNull() && FORM_ACTIONS.has(actionType(action))) { counts.formActions++; if (!dryRun) field.delete('A'); }
        });
        for (const key of ['CO', 'XFA']) if (!form.get(key).isNull()) { counts.formActions++; if (!dryRun) form.delete(key); }
      }
    }
    if (options.links && !root.get('URI').isNull()) { counts.links++; if (!dryRun) root.delete('URI'); }
  } finally {
    for (const page of pages) page.destroy?.();
  }
  return counts;
}
