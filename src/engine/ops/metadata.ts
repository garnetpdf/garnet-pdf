import type * as mupdf from 'mupdf';
import type { EngineContext } from '../context';
import type { OpResult } from '../../shared/engine-api';

export interface FontSummary { name: string; type: string; embedded: boolean; subset: boolean; encoding: string }
export interface DocumentProperties {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  created: string | null;
  modified: string | null;
  version: string;
  pageCount: number;
  /** Size of the current page in points, and whether other pages differ. */
  pageSize: { width: number; height: number; mixed: boolean };
  fonts: FontSummary[];
  fontsTruncated: boolean;
  hasXmp: boolean;
}
export type EditableProperties = Pick<DocumentProperties, 'title' | 'author' | 'subject' | 'keywords'>;

declare module '../../shared/engine-api' {
  interface EngineOps {
    'metadata.get': { args: { docId: string; pageIndex?: number }; result: DocumentProperties };
    'metadata.set': { args: { docId: string; fields: EditableProperties }; result: OpResult | null };
  }
}

const INFO_KEYS: Record<keyof EditableProperties, string> = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords' };

/** "D:YYYYMMDDHHmmSSOHH'mm'" to ISO 8601, or null. */
export function parsePdfDate(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/);
  if (!match) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', sign, oh = '00', om = '00'] = match;
  const zone = !sign || sign.toUpperCase() === 'Z' ? 'Z' : `${sign}${oh}:${om}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fontSummary(font: mupdf.PDFObject): FontSummary {
  const subtype = font.get('Subtype').isName() ? font.get('Subtype').asName() : 'Unknown';
  const base = font.get('BaseFont').isName() ? font.get('BaseFont').asName() : subtype === 'Type3' ? 'Type 3 font' : 'Unnamed font';
  let descriptor = font.get('FontDescriptor');
  let type = subtype;
  if (subtype === 'Type0') {
    const descendant = font.get('DescendantFonts').get(0);
    descriptor = descendant.get('FontDescriptor');
    const cid = descendant.get('Subtype');
    type = cid.isName() ? `Type0 (${cid.asName()})` : 'Type0';
  }
  const embedded = subtype === 'Type3' || ['FontFile', 'FontFile2', 'FontFile3'].some(key => descriptor.isDictionary() && !descriptor.get(key).isNull());
  const encoding = font.get('Encoding');
  return {
    name: base.replace(/^[A-Z]{6}\+/, ''),
    type,
    embedded,
    subset: /^[A-Z]{6}\+/.test(base),
    encoding: encoding.isName() ? encoding.asName() : encoding.isDictionary() ? 'Custom' : subtype === 'Type0' ? 'CMap' : 'Built-in',
  };
}

function collectFonts(pdf: mupdf.PDFDocument, limit = 500): { fonts: FontSummary[]; truncated: boolean } {
  const seen = new Set<number>();
  const visitedResources = new Set<number>();
  const fonts: FontSummary[] = [];
  let truncated = false;
  const visitResources = (resources: mupdf.PDFObject, depth: number) => {
    if (!resources.isDictionary() || depth > 12 || truncated) return;
    if (resources.isIndirect()) {
      if (visitedResources.has(resources.asIndirect())) return;
      visitedResources.add(resources.asIndirect());
    }
    resources.get('Font').forEach(value => {
      if (truncated) return;
      const key = value.isIndirect() ? value.asIndirect() : -1;
      if (key >= 0 && seen.has(key)) return;
      if (key >= 0) seen.add(key);
      const font = value.resolve();
      if (!font.isDictionary()) return;
      if (fonts.length >= limit) { truncated = true; return; }
      fonts.push(fontSummary(font));
      if (font.get('Subtype').isName() && font.get('Subtype').asName() === 'Type3') visitResources(font.get('Resources'), depth + 1);
    });
    resources.get('XObject').forEach(value => {
      const xobject = value.resolve();
      if (xobject.isStream() && xobject.get('Subtype').isName() && xobject.get('Subtype').asName() === 'Form') visitResources(xobject.get('Resources'), depth + 1);
    });
  };
  for (let i = 0; i < pdf.countPages() && !truncated; i++) visitResources(pdf.findPage(i).getInheritable('Resources'), 0);
  fonts.sort((a, b) => a.name.localeCompare(b.name));
  return { fonts, truncated };
}

export const namespace = 'metadata';
export const ops = {
  'metadata.get': (ctx: EngineContext, args: { docId: string; pageIndex?: number }): DocumentProperties => {
    const { pdf } = ctx.get(args.docId);
    const meta = (key: string) => pdf.getMetaData(key) ?? '';
    const pages = ctx.pages(args.docId);
    const current = pages[Math.max(0, Math.min(pages.length - 1, args.pageIndex ?? 0))];
    const mixed = pages.some(page => Math.abs(page.width - current.width) > 0.5 || Math.abs(page.height - current.height) > 0.5);
    const { fonts, truncated } = collectFonts(pdf);
    const version = pdf.getVersion();
    return {
      title: meta('info:Title'),
      author: meta('info:Author'),
      subject: meta('info:Subject'),
      keywords: meta('info:Keywords'),
      creator: meta('info:Creator'),
      producer: meta('info:Producer'),
      created: parsePdfDate(meta('info:CreationDate')),
      modified: parsePdfDate(meta('info:ModDate')),
      version: `${Math.floor(version / 10)}.${version % 10}`,
      pageCount: pages.length,
      pageSize: { width: current.width, height: current.height, mixed },
      fonts,
      fontsTruncated: truncated,
      hasXmp: !pdf.getTrailer().get('Root').get('Metadata').isNull(),
    };
  },
  'metadata.set': (ctx: EngineContext, args: { docId: string; fields: EditableProperties }) => {
    const { pdf } = ctx.get(args.docId);
    const changes = (Object.keys(INFO_KEYS) as (keyof EditableProperties)[]).filter(key => (pdf.getMetaData(`info:${INFO_KEYS[key]}`) ?? '') !== args.fields[key].trim());
    if (!changes.length) return null;
    return ctx.mutate(args.docId, 'Edit document properties', [], live => {
      let info = live.getTrailer().get('Info');
      if (!info.isDictionary()) {
        info = live.addObject(live.newDictionary());
        // Fetch the trailer again: the first change of a document moves it to a new xref section, and MuPDF
        // does not journal trailer keys. The new Info object itself is journalled, so undo removes it.
        live.getTrailer().put('Info', info);
      }
      for (const key of changes) {
        const value = args.fields[key].trim().slice(0, 2000);
        if (value) info.put(INFO_KEYS[key], live.newString(value));
        else info.delete(INFO_KEYS[key]);
      }
    });
  },
};
