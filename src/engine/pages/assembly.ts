/**
 * Copies pages between documents (or within one document) with what MuPDF's graftPage leaves
 * behind: annotations (appearance streams, popups, replies), form widgets merged into the target
 * AcroForm (top-level name collisions get a numeric suffix, /DR merged, /NeedAppearances kept),
 * optional content groups registered in the target /OCProperties, links and bookmarks retargeted
 * to the copied pages. Links and bookmarks to pages that are not copied are dropped.
 *
 * Content streams, resources and appearance streams are copied with MuPDF's graft map (C speed,
 * shared resources copied once per operation). Keys that can point back at pages (/P, /Parent,
 * /Dest, /A, /Popup, /IRT, ...) are never grafted; they are rebuilt from the copy maps instead,
 * so a copy can never drag the source page tree into the target.
 */
import * as mupdf from 'mupdf';
import { compactSpecs, isPlainNumbering, readLabelRanges, specsFor, writeLabelRanges, type LabelSpec } from './labels';
import { NamedDests, destArray, destPageNum, itemDest, linkChildren, num, pageRefs, readOutline, recountOutline, str, type Doc, type Obj, type OutlineNode } from './pdf';

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;
const PAGE_KEYS = ['BleedBox', 'TrimBox', 'ArtBox', 'BoxColorInfo', 'Group', 'Thumb', 'Dur', 'Trans', 'UserUnit', 'Tabs', 'VP', 'Metadata', 'PZ'] as const;
const ANNOT_SKIP = new Set(['P', 'Parent', 'Popup', 'IRT', 'StructParent', 'Dest', 'A', 'AA', 'Kids']);
const FIELD_SKIP = new Set(['Kids', 'Parent', 'P', 'A', 'AA', 'StructParent']);
const SAFE_ACTIONS = new Set(['URI', 'Launch', 'Named', 'GoToR', 'GoToE', 'JavaScript', 'SubmitForm', 'ResetForm', 'ImportData', 'SetOCGState']);

/** Copies direct dictionaries and arrays; indirect objects stay shared (same document only). */
export function cloneDirect(pdf: Doc, value: Obj): Obj {
  if (value.isIndirect()) return value;
  if (value.isArray()) {
    const out = pdf.newArray();
    for (let i = 0; i < value.length; i++) out.push(cloneDirect(pdf, value.get(i)));
    return out;
  }
  if (value.isDictionary()) {
    const out = pdf.newDictionary();
    value.forEach((v, k) => out.put(k, cloneDirect(pdf, v)));
    return out;
  }
  return value;
}

export interface CopyStats {
  pages: number;
  annotations: number;
  widgets: number;
  renamedFields: [string, string][];
  droppedLinks: number;
  layers: number;
}

export class PageCopier {
  readonly same: boolean;
  readonly pageMap = new Map<number, Obj>();
  private readonly map?: mupdf.PDFGraftMap;
  private readonly srcRefs: Obj[];
  private readonly named: NamedDests;
  private readonly annotMap = new Map<number, Obj>();
  private readonly fieldMap = new Map<number, Obj>();
  private readonly copiedSources: Obj[] = [];
  private topNames?: Set<string>;
  readonly stats: CopyStats = { pages: 0, annotations: 0, widgets: 0, renamedFields: [], droppedLinks: 0, layers: 0 };

  constructor(readonly target: Doc, readonly source: Doc) {
    this.same = target === source;
    if (!this.same) this.map = target.newGraftMap();
    this.srcRefs = pageRefs(source);
    this.named = new NamedDests(source);
  }

  /** Copies the source pages (source indices, in order) into the target starting at `at`. */
  copyPages(indices: readonly number[], at: number): Obj[] {
    const count = this.srcRefs.length;
    for (const index of indices) if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('A copied page is outside the source document.');
    const created: Obj[] = [];
    indices.forEach((index, k) => {
      const src = this.srcRefs[index];
      const page = this.createPage(src);
      this.target.insertPage(at + k, page);
      if (!this.pageMap.has(src.asIndirect())) this.pageMap.set(src.asIndirect(), page);
      created.push(page);
      this.copiedSources.push(src);
    });
    indices.forEach((index, k) => this.copyAnnots(this.srcRefs[index], created[k]));
    this.stats.pages += created.length;
    return created;
  }

  /** Target destination array for a source destination, or null when its page was not copied. */
  mapDest(dest: Obj): Obj | null {
    const array = destArray(dest, this.named);
    if (!array || array.length < 1) return null;
    const pageNum = destPageNum(array, this.named, this.srcRefs);
    if (pageNum === null) return null;
    const page = this.same ? this.target.newIndirect(pageNum) : this.pageMap.get(pageNum);
    if (!page) return null;
    const out = this.target.newArray();
    out.push(page);
    for (let i = 1; i < array.length; i++) out.push(this.value(array.get(i)));
    return out;
  }

  finish(): CopyStats {
    try {
      if (!this.same) {
        if (this.stats.widgets) this.mergeFormDefaults();
        this.copyOptionalContent();
      }
    } finally {
      this.map?.destroy();
    }
    return this.stats;
  }

  private value(v: Obj): Obj {
    return this.same ? cloneDirect(this.target, v) : this.map!.graftObject(v);
  }

  private copyStream(ref: Obj): Obj {
    if (!this.same) return this.map!.graftObject(ref);
    if (!ref.isStream()) return cloneDirect(this.target, ref);
    const raw = ref.readRawStream();
    try {
      const dict = this.target.newDictionary();
      ref.forEach((v, k) => { if (k !== 'Length') dict.put(k, cloneDirect(this.target, v)); });
      return this.target.addRawStream(raw, dict);
    } finally {
      raw.destroy();
    }
  }

  private copyAppearance(ap: Obj): Obj {
    if (!this.same) return this.value(ap);
    const out = this.target.newDictionary();
    ap.forEach((value, key) => {
      if (value.isStream()) out.put(key, this.copyStream(value));
      else if (value.isDictionary()) {
        const states = this.target.newDictionary();
        value.forEach((state, name) => states.put(name, state.isStream() ? this.copyStream(state) : cloneDirect(this.target, state)));
        out.put(key, states);
      } else out.put(key, cloneDirect(this.target, value));
    });
    return out;
  }

  private createPage(src: Obj): Obj {
    const t = this.target;
    const dict = t.newDictionary();
    dict.put('Type', t.newName('Page'));
    for (const key of INHERITABLE) {
      const v = src.getInheritable(key);
      if (!v.isNull()) dict.put(key, this.same && key === 'Resources' ? shallowCopy(t, v) : this.value(v));
    }
    for (const key of PAGE_KEYS) {
      const v = src.get(key);
      if (!v.isNull()) dict.put(key, this.value(v));
    }
    const contents = src.get('Contents');
    if (contents.isArray()) {
      const array = t.newArray();
      for (let i = 0; i < contents.length; i++) array.push(this.copyStream(contents.get(i)));
      dict.put('Contents', array);
    } else if (!contents.isNull()) dict.put('Contents', this.copyStream(contents));
    if (dict.get('MediaBox').isNull()) dict.put('MediaBox', [0, 0, 612, 792]);
    return t.addObject(dict);
  }

  private copyAnnots(src: Obj, page: Obj): void {
    const annots = src.get('Annots');
    if (!annots.isArray()) return;
    const t = this.target;
    const copied: { src: Obj; dst: Obj; subtype: string }[] = [];
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i);
      if (!annot.isDictionary()) continue;
      const subtype = annot.get('Subtype').isName() ? annot.get('Subtype').asName() : '';
      const dict = t.newDictionary();
      annot.forEach((v, key) => { const k = String(key); if (!ANNOT_SKIP.has(k)) dict.put(k, k === 'AP' ? this.copyAppearance(v) : this.value(v)); });
      let keep = true;
      const dest = annot.get('Dest');
      if (!dest.isNull()) {
        const mapped = this.same ? cloneDirect(t, dest) : this.mapDest(dest);
        if (mapped) dict.put('Dest', mapped);
        else keep = false;
      }
      const action = annot.get('A');
      if (!action.isNull()) {
        const mapped = this.copyAction(action, 0);
        if (mapped) dict.put('A', mapped);
        else if (subtype === 'Link') keep = false;
      }
      const aa = annot.get('AA');
      if (aa.isDictionary()) {
        const triggers = t.newDictionary();
        aa.forEach((v, k) => { const mapped = this.copyAction(v, 0); if (mapped) triggers.put(k, mapped); });
        dict.put('AA', triggers);
      }
      if (!keep) { this.stats.droppedLinks++; continue; }
      dict.put('P', page);
      const ref = t.addObject(dict);
      if (annot.isIndirect()) this.annotMap.set(annot.asIndirect(), ref);
      copied.push({ src: annot, dst: ref, subtype });
    }
    const out = t.newArray();
    for (const item of copied) {
      const popup = item.src.get('Popup');
      if (popup.isIndirect() && this.annotMap.has(popup.asIndirect())) item.dst.put('Popup', this.annotMap.get(popup.asIndirect())!);
      const irt = item.src.get('IRT');
      if (irt.isIndirect() && this.annotMap.has(irt.asIndirect())) item.dst.put('IRT', this.annotMap.get(irt.asIndirect())!);
      if (item.subtype === 'Popup') {
        const parent = item.src.get('Parent');
        if (parent.isIndirect() && this.annotMap.has(parent.asIndirect())) item.dst.put('Parent', this.annotMap.get(parent.asIndirect())!);
        else continue;
      }
      if (item.subtype === 'Widget') { this.linkWidget(item.src, item.dst); this.stats.widgets++; }
      this.stats.annotations++;
      out.push(item.dst);
    }
    if (out.length) page.put('Annots', out);
  }

  private copyAction(action: Obj, depth: number): Obj | null {
    if (this.same) return cloneDirect(this.target, action);
    if (depth > 8) return null;
    const a = action;
    if (!a.isDictionary()) return null;
    const t = this.target;
    const s = a.get('S').isName() ? a.get('S').asName() : '';
    let out: Obj;
    if (s === 'GoTo') {
      const dest = this.mapDest(a.get('D'));
      if (!dest) return null;
      out = t.newDictionary();
      out.put('S', t.newName('GoTo'));
      out.put('D', dest);
    } else if (SAFE_ACTIONS.has(s)) {
      out = t.newDictionary();
      a.forEach((v, k) => {
        if (k === 'Next') return;
        if ((s === 'SubmitForm' || s === 'ResetForm') && k === 'Fields') {
          const names = t.newArray();
          for (let i = 0; i < (v.isArray() ? v.length : 0); i++) {
            const entry = v.get(i);
            const name = entry.isString() ? entry.asString() : entry.isDictionary() ? qualifiedName(entry) : '';
            if (name) names.push(t.newString(name));
          }
          out.put('Fields', names);
          return;
        }
        out.put(k, this.value(v));
      });
    } else return null;
    const next = a.get('Next');
    if (next.isArray()) {
      const list = t.newArray();
      for (let i = 0; i < next.length; i++) { const mapped = this.copyAction(next.get(i), depth + 1); if (mapped) list.push(mapped); }
      if (list.length) out.put('Next', list);
    } else if (next.isDictionary()) {
      const mapped = this.copyAction(next, depth + 1);
      if (mapped) out.put('Next', mapped);
    }
    return out;
  }

  private acroForm(): Obj {
    const root = this.target.getTrailer().get('Root');
    let form = root.get('AcroForm');
    if (!form.isDictionary()) {
      form = this.target.addObject(this.target.newDictionary());
      root.put('AcroForm', form);
    }
    if (!form.get('Fields').isArray()) form.put('Fields', this.target.newArray());
    return form;
  }

  private addTopLevel(ref: Obj): void {
    const form = this.acroForm();
    const fields = form.get('Fields');
    if (!this.topNames) {
      this.topNames = new Set();
      for (let i = 0; i < fields.length; i++) { const name = str(fields.get(i).get('T')); if (name) this.topNames.add(name); }
    }
    const name = ref.get('T').isString() ? ref.get('T').asString() : '';
    if (name) {
      let final = name;
      if (this.topNames.has(name)) {
        let k = 2;
        while (this.topNames.has(`${name}_${k}`)) k++;
        final = `${name}_${k}`;
        ref.put('T', this.target.newString(final));
        this.stats.renamedFields.push([name, final]);
      }
      this.topNames.add(final);
    }
    fields.push(ref);
  }

  private kids(ref: Obj): Obj {
    let kids = ref.get('Kids');
    if (!kids.isArray()) {
      kids = this.target.newArray();
      ref.put('Kids', kids);
    }
    return ref.get('Kids');
  }

  private linkWidget(srcWidget: Obj, dstWidget: Obj): void {
    const parent = srcWidget.get('Parent');
    if (parent.isDictionary() && parent.isIndirect()) {
      const newParent = this.copyField(parent, 0);
      dstWidget.put('Parent', newParent);
      this.kids(newParent).push(dstWidget);
    } else if (!srcWidget.get('T').isNull() || !srcWidget.get('FT').isNull()) {
      this.addTopLevel(dstWidget);
    }
  }

  private copyField(src: Obj, depth: number): Obj {
    const id = src.asIndirect();
    const existing = this.fieldMap.get(id);
    if (existing) return existing;
    const t = this.target;
    const dict = t.newDictionary();
    src.forEach((v, key) => { const k = String(key); if (!FIELD_SKIP.has(k)) dict.put(k, this.value(v)); });
    const action = src.get('A');
    if (!action.isNull()) { const mapped = this.copyAction(action, 0); if (mapped) dict.put('A', mapped); }
    const aa = src.get('AA');
    if (aa.isDictionary()) {
      const triggers = t.newDictionary();
      aa.forEach((v, k) => { const mapped = this.copyAction(v, 0); if (mapped) triggers.put(k, mapped); });
      dict.put('AA', triggers);
    }
    const ref = t.addObject(dict);
    this.fieldMap.set(id, ref);
    const parent = src.get('Parent');
    if (depth < 32 && parent.isDictionary() && parent.isIndirect()) {
      const newParent = this.copyField(parent, depth + 1);
      ref.put('Parent', newParent);
      this.kids(newParent).push(ref);
    } else this.addTopLevel(ref);
    return ref;
  }

  private mergeFormDefaults(): void {
    const srcForm = this.source.getTrailer().get('Root').get('AcroForm');
    if (!srcForm.isDictionary()) return;
    const form = this.acroForm();
    const srcDR = srcForm.get('DR');
    if (srcDR.isDictionary()) {
      let dr = form.get('DR');
      if (!dr.isDictionary()) { form.put('DR', this.target.newDictionary()); dr = form.get('DR'); }
      srcDR.forEach((category, key) => {
        if (!category.isDictionary()) { if (dr.get(key).isNull()) dr.put(key, this.value(category)); return; }
        let mine = dr.get(key);
        if (!mine.isDictionary()) { dr.put(key, this.target.newDictionary()); mine = dr.get(key); }
        category.forEach((resource, name) => { if (mine.get(name).isNull()) mine.put(name, this.value(resource)); });
      });
    }
    for (const key of ['DA', 'Q']) if (form.get(key).isNull() && !srcForm.get(key).isNull()) form.put(key, this.value(srcForm.get(key)));
    const need = srcForm.get('NeedAppearances');
    if (need.isBoolean() && need.asBoolean()) form.put('NeedAppearances', true);
  }

  private copyOptionalContent(): void {
    const srcProps = this.source.getTrailer().get('Root').get('OCProperties');
    if (!srcProps.isDictionary()) return;
    const groups = srcProps.get('OCGs');
    if (!groups.isArray() || !groups.length) return;
    const reachable = new Set<number>();
    const stack: Obj[] = [];
    for (const page of this.copiedSources) { stack.push(page.getInheritable('Resources')); stack.push(page.get('Annots')); }
    while (stack.length) {
      const o = stack.pop()!;
      if (o.isIndirect()) { const n = o.asIndirect(); if (reachable.has(n)) continue; reachable.add(n); }
      if (o.isArray()) for (let i = 0; i < o.length; i++) stack.push(o.get(i));
      else if (o.isDictionary()) o.forEach((v, k) => { if (k !== 'Parent' && k !== 'P' && k !== 'Popup' && k !== 'IRT' && k !== 'Dest' && k !== 'A') stack.push(v); });
    }
    const off = new Set<number>();
    const srcOff = srcProps.get('D', 'OFF');
    if (srcOff.isArray()) for (let i = 0; i < srcOff.length; i++) off.add(num(srcOff.get(i)));
    const t = this.target;
    const root = t.getTrailer().get('Root');
    for (let i = 0; i < groups.length; i++) {
      const group = groups.get(i);
      if (!group.isIndirect() || !reachable.has(group.asIndirect())) continue;
      const copy = this.map!.graftObject(group);
      let props = root.get('OCProperties');
      if (!props.isDictionary()) { root.put('OCProperties', t.newDictionary()); props = root.get('OCProperties'); }
      if (!props.get('OCGs').isArray()) props.put('OCGs', t.newArray());
      if (!props.get('D').isDictionary()) props.put('D', t.newDictionary());
      const list = props.get('OCGs');
      let present = false;
      for (let j = 0; j < list.length; j++) if (num(list.get(j)) === copy.asIndirect()) present = true;
      if (present) continue;
      list.push(copy);
      const d = props.get('D');
      if (!d.get('Order').isArray()) d.put('Order', t.newArray());
      d.get('Order').push(copy);
      if (off.has(group.asIndirect())) {
        if (!d.get('OFF').isArray()) d.put('OFF', t.newArray());
        d.get('OFF').push(copy);
      }
      this.stats.layers++;
    }
  }
}

function shallowCopy(pdf: Doc, dict: Obj): Obj {
  const out = pdf.newDictionary();
  dict.forEach((v, k) => out.put(k, cloneDirect(pdf, v)));
  return out;
}

function qualifiedName(field: Obj): string {
  const parts: string[] = [];
  let node: Obj = field;
  for (let depth = 0; depth < 32 && node.isDictionary(); depth++) {
    const t = node.get('T');
    if (t.isString()) parts.unshift(t.asString());
    node = node.get('Parent');
  }
  return parts.join('.');
}

export interface OutlineSpec {
  title: string;
  dest: Obj | null;
  open: boolean;
  color?: Obj;
  flags?: number;
  children: OutlineSpec[];
}

/** Bookmarks of the source that land on copied pages (parents without a copied target are kept
 * when they still have children, pointing at their first kept child). */
export function outlineSubset(copier: PageCopier): OutlineSpec[] {
  const { items } = readOutline(copier.source);
  const build = (nodes: OutlineNode[]): OutlineSpec[] => {
    const out: OutlineSpec[] = [];
    for (const node of nodes) {
      const children = build(node.children);
      const dest = itemDest(node.ref);
      let mapped = dest ? copier.mapDest(dest) : null;
      if (!mapped && children.length) mapped = children[0].dest;
      if (!mapped && !children.length) continue;
      const count = node.ref.get('Count');
      const color = node.ref.get('C');
      const flags = node.ref.get('F');
      out.push({
        title: str(node.ref.get('Title')),
        dest: mapped,
        open: count.isNumber() && count.asNumber() > 0,
        color: color.isArray() ? copier.target.newArray() : undefined,
        flags: flags.isNumber() ? flags.asNumber() : undefined,
        children,
      });
      if (color.isArray()) for (let i = 0; i < color.length; i++) out[out.length - 1].color!.push(color.get(i).asNumber());
    }
    return out;
  };
  return build(items);
}

/** Appends bookmark specs to the end of the target outline. */
export function appendOutline(pdf: Doc, specs: readonly OutlineSpec[]): void {
  if (!specs.length) return;
  const root = pdf.getTrailer().get('Root');
  let outlines = root.get('Outlines');
  if (!outlines.isDictionary()) {
    const dict = pdf.newDictionary();
    dict.put('Type', pdf.newName('Outlines'));
    outlines = pdf.addObject(dict);
    root.put('Outlines', outlines);
  }
  const existing = readOutline(pdf);
  const create = (spec: OutlineSpec): OutlineNode => {
    const dict = pdf.newDictionary();
    dict.put('Title', pdf.newString(spec.title));
    if (spec.dest) dict.put('Dest', spec.dest);
    if (spec.color) dict.put('C', spec.color);
    if (spec.flags) dict.put('F', spec.flags);
    const ref = pdf.addObject(dict);
    const children = spec.children.map(create);
    if (children.length) {
      linkChildren(ref, children.map((c) => c.ref));
      ref.put('Count', spec.open ? 1 : -1);
    }
    return { ref, children };
  };
  const added = specs.map(create);
  const all = [...existing.items, ...added];
  linkChildren(outlines, all.map((node) => node.ref));
  recountOutline(outlines, all);
}

export interface AssemblyPart {
  pdf: Doc;
  indices: readonly number[];
  title?: string;
}

/** Builds a new document from page lists of one or more sources. */
export function assemble(parts: readonly AssemblyPart[], options: { bookmarks: 'subset' | 'per-source' | 'none'; labels: boolean }): { pdf: Doc; stats: CopyStats[] } {
  const out = new mupdf.PDFDocument();
  try {
    const specs: LabelSpec[] = [];
    let anyLabels = false;
    const outline: OutlineSpec[] = [];
    const stats: CopyStats[] = [];
    for (const part of parts) {
      if (!part.indices.length) continue;
      const copier = new PageCopier(out, part.pdf);
      const created = copier.copyPages(part.indices, out.countPages());
      const ranges = readLabelRanges(part.pdf);
      if (ranges) anyLabels = true;
      const partSpecs = specsFor(ranges, part.pdf.countPages());
      for (const index of part.indices) specs.push(partSpecs[index]);
      if (options.bookmarks !== 'none') {
        const subset = outlineSubset(copier);
        if (options.bookmarks === 'per-source') {
          const dest = out.newArray();
          dest.push(created[0]);
          dest.push(out.newName('Fit'));
          outline.push({ title: part.title || 'Document', dest, open: false, children: subset });
        } else outline.push(...subset);
      }
      stats.push(copier.finish());
    }
    if (!out.countPages()) throw new Error('Choose at least one page.');
    appendOutline(out, outline);
    const ranges = options.labels && anyLabels ? compactSpecs(specs) : null;
    writeLabelRanges(out, ranges && !isPlainNumbering(ranges) ? ranges : null, out.countPages());
    return { pdf: out, stats };
  } catch (error) {
    out.destroy();
    throw error;
  }
}

export function saveDocument(pdf: Doc): Uint8Array {
  const buffer = pdf.saveToBuffer('garbage=compact,compress,objstms');
  try { return Uint8Array.from(buffer.asUint8Array()); } finally { buffer.destroy(); }
}

/**
 * Opens PDF or image bytes as a MuPDF document. An image becomes one page at its own resolution,
 * or, with `fitTo`, a page of that size with the image centred and scaled to fit.
 */
export function openSource(bytes: ArrayBuffer | Uint8Array, fitTo?: [number, number]): Doc {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pdfMagic = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
  if (pdfMagic) {
    const pdf = mupdf.Document.openDocument(data, 'application/pdf').asPDF();
    if (!pdf) throw new Error('This file is not a PDF.');
    if (pdf.needsPassword()) { pdf.destroy(); throw new Error('This PDF is password protected. Open it first, then copy pages from its tab.'); }
    return pdf;
  }
  const image = new mupdf.Image(data);
  const pdf = new mupdf.PDFDocument();
  try {
    let width = (image.getWidth() * 72) / (image.getXResolution() || 72);
    let height = (image.getHeight() * 72) / (image.getYResolution() || 72);
    const limit = 14400 / Math.max(width, height);
    if (limit < 1) { width *= limit; height *= limit; }
    const reference = pdf.addImage(image);
    const xObject = pdf.newDictionary();
    xObject.put('Image0', reference);
    const resources = pdf.newDictionary();
    resources.put('XObject', xObject);
    let box: [number, number, number, number] = [0, 0, width, height];
    let placement = `${width} 0 0 ${height} 0 0`;
    if (fitTo) {
      const [pw, ph] = fitTo;
      const scale = Math.min(pw / width, ph / height);
      const w = width * scale, h = height * scale;
      box = [0, 0, pw, ph];
      placement = [w, 0, 0, h, (pw - w) / 2, (ph - h) / 2].map((v) => Math.round(v * 1000) / 1000).join(' ');
    }
    const page = pdf.addPage(box, 0, resources, `q ${placement} cm /Image0 Do Q`);
    pdf.insertPage(0, page);
    return pdf;
  } catch (error) {
    pdf.destroy();
    throw error;
  } finally {
    image.destroy();
  }
}
