import * as mupdf from 'mupdf';
import type { EngineContext } from '../context';
import type { OpResult } from '../../shared/engine-api';
import { itemCount, rootCount, type BookmarkNode } from '../tools/panels/outline-tree';

declare module '../../shared/engine-api' {
  interface EngineOps {
    'outline.get': { args: { docId: string }; result: BookmarkNode[] };
    'outline.set': { args: { docId: string; tree: BookmarkNode[]; label: string }; result: OpResult };
  }
}

type LoadedItem = NonNullable<ReturnType<mupdf.PDFDocument['loadOutline']>>[number];

/** Walks the outline objects; page numbers come from MuPDF's own resolution of the same items. */
function readTree(pdf: mupdf.PDFDocument): BookmarkNode[] {
  const outlines = pdf.getTrailer().get('Root').get('Outlines');
  if (!outlines.isDictionary()) return [];
  const seen = new Set<number>();
  const walk = (first: mupdf.PDFObject, loaded: LoadedItem[] | undefined, depth: number): BookmarkNode[] => {
    const nodes: BookmarkNode[] = [];
    let item = first;
    let index = 0;
    while (item.isDictionary() && depth < 64 && nodes.length < 10000) {
      const key = item.isIndirect() ? item.asIndirect() : undefined;
      if (key !== undefined) {
        if (seen.has(key)) break;
        seen.add(key);
      }
      const match = loaded?.[index];
      const title = item.get('Title');
      const count = item.get('Count');
      nodes.push({
        key,
        id: key !== undefined ? `o${key}` : `n${depth}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        title: title.isString() ? title.asString() : match?.title ?? '',
        pageIndex: match?.page ?? null,
        uri: match?.uri && !match.uri.startsWith('#') ? match.uri : undefined,
        open: count.isNumber() ? count.asNumber() > 0 : Boolean(match?.open),
        children: walk(item.get('First'), match?.down, depth + 1),
      });
      item = item.get('Next');
      index++;
    }
    return nodes;
  };
  return walk(outlines.get('First'), pdf.loadOutline() ?? undefined, 0);
}

function collectKeys(pdf: mupdf.PDFDocument): Set<number> {
  const keys = new Set<number>();
  const visit = (nodes: BookmarkNode[]) => nodes.forEach(node => { if (node.key !== undefined) keys.add(node.key); visit(node.children); });
  visit(readTree(pdf));
  return keys;
}

export const namespace = 'outline';
export const ops = {
  'outline.get': (ctx: EngineContext, args: { docId: string }) => readTree(ctx.get(args.docId).pdf),
  /** Rewrites the outline linkage (/First /Last /Prev /Next /Parent /Count) from the edited tree in one step. */
  'outline.set': (ctx: EngineContext, args: { docId: string; tree: BookmarkNode[]; label: string }) => {
    const existing = collectKeys(ctx.get(args.docId).pdf);
    return ctx.mutate(args.docId, args.label || 'Edit bookmarks', [], pdf => {
      const root = pdf.getTrailer().get('Root');
      if (!args.tree.length) {
        root.delete('Outlines');
        if (root.get('PageMode').isName() && root.get('PageMode').asName() === 'UseOutlines') root.delete('PageMode');
        return;
      }
      let outlines = root.get('Outlines');
      if (!outlines.isDictionary() || !outlines.isIndirect()) {
        outlines = pdf.addObject(pdf.newDictionary());
        root.put('Outlines', outlines);
      }
      outlines.put('Type', pdf.newName('Outlines'));
      const build = (nodes: BookmarkNode[], parent: mupdf.PDFObject): mupdf.PDFObject[] => {
        const objects = nodes.map(node => {
          let object: mupdf.PDFObject;
          if (node.key !== undefined && existing.has(node.key)) object = pdf.newIndirect(node.key);
          else {
            object = pdf.addObject(pdf.newDictionary());
            if (node.pageId !== undefined) {
              const index = ctx.pageIndex(args.docId, node.pageId);
              const page = pdf.loadPage(index);
              const inverse = mupdf.Matrix.invert(page.getTransform());
              page.destroy();
              // The view position is in page space (top-left origin, rotation applied); /XYZ takes default user space.
              const y = Math.max(0, node.top ?? 0);
              const left = inverse[2] * y + inverse[4], top = inverse[3] * y + inverse[5];
              const dest = pdf.newArray();
              dest.push(pdf.findPage(index));
              dest.push(pdf.newName('XYZ'));
              dest.push(Math.round(left * 100) / 100);
              dest.push(Math.round(top * 100) / 100);
              dest.push(pdf.newNull());
              object.put('Dest', dest);
            }
          }
          object.put('Title', pdf.newString(node.title.slice(0, 500)));
          object.put('Parent', parent);
          for (const key of ['First', 'Last', 'Prev', 'Next', 'Count']) object.delete(key);
          return object;
        });
        objects.forEach((object, i) => {
          if (i > 0) object.put('Prev', objects[i - 1]);
          if (i < objects.length - 1) object.put('Next', objects[i + 1]);
          const node = nodes[i];
          const children = build(node.children, object);
          if (children.length) {
            object.put('First', children[0]);
            object.put('Last', children[children.length - 1]);
            const count = itemCount(node);
            if (count !== null) object.put('Count', count);
          }
        });
        return objects;
      };
      const top = build(args.tree, outlines);
      outlines.put('First', top[0]);
      outlines.put('Last', top[top.length - 1]);
      outlines.put('Count', rootCount(args.tree));
    });
  },
};
