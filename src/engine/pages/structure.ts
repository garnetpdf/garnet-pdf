/**
 * Structural page edits on a live (journaled) document. Callers wrap each public function in one
 * engine operation. Moves use MuPDF deletePage/insertPage on the same page objects, so page
 * identity, bookmarks, links and named destinations follow the pages. rearrangePages is not used
 * on live documents: in MuPDF 1.28.6 its undo does not restore /PageLabels or the /Dests tree.
 */
import { afterDelete, afterInsert, readLabelRanges, writeLabelRanges } from './labels';
import {
  NamedDests, destArray, destPageNum, filterNameTree, itemDest, linkChildren, normaliseRotation, num, pageIndexByNum, pageRefs, readOutline,
  recountOutline, type Doc, type Obj, type OutlineNode,
} from './pdf';

export function assertIndices(pdf: Doc, indices: readonly number[], what = 'page'): void {
  const count = pdf.countPages();
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`The ${what} list includes a page outside this document.`);
    if (seen.has(index)) throw new Error(`The ${what} list includes the same page twice.`);
    seen.add(index);
  }
}

/** Reorders the existing pages into the given order (same set of page objects). */
export function reorderTo(pdf: Doc, target: readonly Obj[]): number {
  const refs = pageRefs(pdf);
  if (target.length !== refs.length) throw new Error('A reorder must keep every page.');
  const current = refs.map((ref) => ref.asIndirect());
  const wanted = target.map((ref) => ref.asIndirect());
  const check = [...current].sort((a, b) => a - b).join(',') === [...wanted].sort((a, b) => a - b).join(',');
  if (!check) throw new Error('A reorder must keep every page exactly once.');
  const labels = readLabelRanges(pdf);
  let moves = 0;
  for (let i = 0; i < wanted.length; i++) {
    if (current[i] === wanted[i]) continue;
    const j = current.indexOf(wanted[i], i + 1);
    pdf.deletePage(j);
    pdf.insertPage(i, target[i]);
    current.splice(j, 1);
    current.splice(i, 0, wanted[i]);
    moves++;
  }
  if (moves) writeLabelRanges(pdf, labels, pdf.countPages());
  return moves;
}

/** Moves the given pages (in the given order) so that they start at `to` in the final order. */
export function movePages(pdf: Doc, indices: readonly number[], to: number): Obj[] {
  assertIndices(pdf, indices);
  const refs = pageRefs(pdf);
  const moving = new Set(indices);
  const rest = refs.filter((_, i) => !moving.has(i));
  const insertAt = Math.max(0, Math.min(to, rest.length));
  const order = [...rest.slice(0, insertAt), ...indices.map((i) => refs[i]), ...rest.slice(insertAt)];
  reorderTo(pdf, order);
  return order;
}

/** Index in the final order for a drop before `beforeIndex` in the current order. */
export function dropTarget(pageCount: number, indices: readonly number[], beforeIndex: number): number {
  const before = Math.max(0, Math.min(beforeIndex, pageCount));
  return before - indices.filter((i) => i < before).length;
}

export function rotatePages(pdf: Doc, indices: readonly number[], delta: number): void {
  assertIndices(pdf, indices);
  if (delta % 90 !== 0) throw new Error('Pages rotate in steps of 90 degrees.');
  for (const index of indices) {
    const page = pdf.findPage(index);
    const current = page.getInheritable('Rotate');
    const next = normaliseRotation((current.isNumber() ? current.asNumber() : 0) + delta);
    const parent = page.get('Parent');
    const inherited = parent.isDictionary() ? parent.getInheritable('Rotate') : null;
    const inheritedValue = inherited && inherited.isNumber() ? normaliseRotation(inherited.asNumber()) : 0;
    if (next === 0 && inheritedValue === 0) {
      if (!page.get('Rotate').isNull()) page.delete('Rotate');
    } else page.put('Rotate', next);
  }
}

export function insertBlankPages(pdf: Doc, at: number, count: number, size: [number, number], rotate = 0): Obj[] {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Insert between 1 and 1000 blank pages.');
  const [width, height] = size;
  if (!(width >= 3 && height >= 3 && width <= 14400 && height <= 14400)) throw new Error('Page size must be between 3 and 14,400 points.');
  const where = Math.max(0, Math.min(at, pdf.countPages()));
  const labels = readLabelRanges(pdf);
  const created: Obj[] = [];
  for (let k = 0; k < count; k++) {
    const page = pdf.addPage([0, 0, width, height], normaliseRotation(rotate), pdf.newDictionary(), '');
    pdf.insertPage(where + k, page);
    created.push(page);
  }
  if (labels) writeLabelRanges(pdf, afterInsert(labels, where, count), pdf.countPages());
  else writeLabelRanges(pdf, null, pdf.countPages());
  return created;
}

/** Removes pages and everything that would dangle: bookmarks, links, named destinations, the
 * open action and form fields whose widgets sit on removed pages. Bookmarks that still have
 * children are kept and retargeted to the next surviving page. */
export function deletePages(pdf: Doc, indices: readonly number[]): void {
  assertIndices(pdf, indices);
  const refs = pageRefs(pdf);
  if (indices.length >= refs.length) throw new Error('A document must keep at least one page.');
  const labels = readLabelRanges(pdf);
  const deletedIdx = new Set(indices);
  removeDanglingReferences(pdf, refs, deletedIdx);
  for (const index of [...indices].sort((a, b) => b - a)) pdf.deletePage(index);
  writeLabelRanges(pdf, labels ? afterDelete(labels, deletedIdx, refs.length) : null, pdf.countPages());
}

export function removeDanglingReferences(pdf: Doc, refs: readonly Obj[], deletedIdx: ReadonlySet<number>): void {
  const deleted = new Set([...deletedIdx].map((i) => refs[i].asIndirect()));
  const indexByNum = pageIndexByNum(refs);
  const named = new NamedDests(pdf);
  const survivorFor = (pageNum: number): Obj => {
    const index = indexByNum.get(pageNum) ?? 0;
    for (let i = index + 1; i < refs.length; i++) if (!deletedIdx.has(i)) return refs[i];
    for (let i = index - 1; i >= 0; i--) if (!deletedIdx.has(i)) return refs[i];
    throw new Error('A document must keep at least one page.');
  };
  const targetsDeleted = (dest: Obj | null) => {
    if (!dest) return false;
    const target = destPageNum(dest, named, refs);
    return target !== null && deleted.has(target);
  };

  // Bookmarks.
  const outline = readOutline(pdf);
  if (outline.root) {
    const clean = (parent: Obj, children: OutlineNode[]): OutlineNode[] => {
      const kept: OutlineNode[] = [];
      let changed = false;
      for (const child of children) {
        const keptChildren = clean(child.ref, child.children);
        if (keptChildren.length !== child.children.length) changed = true;
        child.children = keptChildren;
        const dest = itemDest(child.ref);
        if (targetsDeleted(dest)) {
          if (keptChildren.length) {
            retargetItem(pdf, child.ref, survivorFor(destPageNum(dest!, named, refs)!));
            kept.push(child);
          } else changed = true;
        } else kept.push(child);
      }
      if (changed) linkChildren(parent, kept.map((node) => node.ref));
      return kept;
    };
    const items = clean(outline.root, outline.items);
    if (items.length) recountOutline(outline.root, items);
    else if (outline.items.length) pdf.getTrailer().get('Root').delete('Outlines');
  }

  // Link annotations on surviving pages, and widgets on deleted pages.
  refs.forEach((page, index) => {
    const annots = page.get('Annots');
    if (!annots.isArray()) return;
    if (deletedIdx.has(index)) {
      for (let i = 0; i < annots.length; i++) {
        const annot = annots.get(i);
        if (annot.get('Subtype').isName() && annot.get('Subtype').asName() === 'Widget') removeFieldNode(pdf, annot);
      }
      return;
    }
    const kept: Obj[] = [];
    let removed = false;
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i);
      const subtype = annot.get('Subtype');
      if (subtype.isName() && subtype.asName() === 'Link' && targetsDeleted(itemDest(annot))) removed = true;
      else kept.push(annot);
    }
    if (removed) {
      const array = pdf.newArray();
      kept.forEach((annot) => array.push(annot));
      page.put('Annots', array);
    }
  });

  // Named destinations.
  const root = pdf.getTrailer().get('Root');
  const tree = root.get('Names', 'Dests');
  if (tree.isDictionary()) filterNameTree(pdf, tree, (_key, value) => !targetsDeleted(value));
  const old = root.get('Dests');
  if (old.isDictionary()) {
    const drop: string[] = [];
    old.forEach((value, key) => { if (targetsDeleted(value)) drop.push(String(key)); });
    drop.forEach((key) => old.delete(key));
  }

  // Open action.
  const open = root.get('OpenAction');
  if (open.isArray() && targetsDeleted(open)) root.delete('OpenAction');
  else if (open.isDictionary() && targetsDeleted(itemDest(pseudoItem(pdf, open)))) root.delete('OpenAction');
}

function pseudoItem(pdf: Doc, action: Obj): Obj {
  const item = pdf.newDictionary();
  item.put('A', action);
  return item;
}

function retargetItem(pdf: Doc, item: Obj, page: Obj): void {
  const next = pdf.newArray();
  next.push(page);
  next.push(pdf.newName('Fit'));
  if (!item.get('A').isNull()) item.delete('A');
  item.put('Dest', next);
}

/** Removes a widget (or field node) from the form field tree, pruning empty parents. */
export function removeFieldNode(pdf: Doc, node: Obj, depth = 0): void {
  if (depth > 32 || !node.isIndirect()) return;
  const id = node.asIndirect();
  const parent = node.get('Parent');
  const acroForm = pdf.getTrailer().get('Root').get('AcroForm');
  const removeFrom = (array: Obj) => {
    if (!array.isArray()) return false;
    for (let i = array.length - 1; i >= 0; i--) if (num(array.get(i)) === id) { array.delete(i); return true; }
    return false;
  };
  if (parent.isDictionary()) {
    const kids = parent.get('Kids');
    removeFrom(kids);
    if (!kids.isArray() || kids.length === 0) removeFieldNode(pdf, parent, depth + 1);
  } else if (acroForm.isDictionary()) {
    removeFrom(acroForm.get('Fields'));
  }
  if (acroForm.isDictionary()) removeFrom(acroForm.get('CO'));
}

/** Points bookmarks, links, named destinations and the open action at new pages. */
export function retargetPageReferences(pdf: Doc, mapping: ReadonlyMap<number, Obj>): void {
  if (!mapping.size) return;
  const refs = pageRefs(pdf);
  const named = new NamedDests(pdf);
  const fixArray = (array: Obj | null) => {
    if (!array || !array.isArray() || array.length < 1) return;
    const first = array.get(0);
    const target = first.isIndirect() ? mapping.get(first.asIndirect()) : undefined;
    if (target) array.put(0, target);
  };
  const fixItem = (item: Obj) => {
    const dest = itemDest(item);
    if (!dest) return;
    const resolved = dest.isIndirect() ? dest.resolve() : dest;
    if (resolved.isName() || resolved.isString()) return; // named destinations are fixed below
    fixArray(resolved.isDictionary() ? resolved.get('D') : resolved);
  };
  const outline = readOutline(pdf);
  const walk = (nodes: OutlineNode[]) => nodes.forEach((node) => { fixItem(node.ref); walk(node.children); });
  walk(outline.items);
  for (const page of refs) {
    const annots = page.get('Annots');
    if (!annots.isArray()) continue;
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i);
      if (annot.get('Subtype').isName() && annot.get('Subtype').asName() === 'Link') fixItem(annot);
    }
  }
  const root = pdf.getTrailer().get('Root');
  const tree = root.get('Names', 'Dests');
  const fixNamed = (value: Obj) => fixArray(destArray(value, named));
  if (tree.isDictionary()) {
    const values: Obj[] = [];
    filterNameTree(pdf, tree, (_key, value) => { values.push(value); return true; });
    values.forEach(fixNamed);
  }
  const old = root.get('Dests');
  if (old.isDictionary()) old.forEach((value) => fixNamed(value));
  const open = root.get('OpenAction');
  if (open.isArray()) fixArray(open);
  else if (open.isDictionary() && open.get('S').isName() && open.get('S').asName() === 'GoTo') fixArray(destArray(open.get('D'), named));
}
