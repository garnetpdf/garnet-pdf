import * as mupdf from 'mupdf';
import {
  encodeText,
  measureCodes,
  interpretPage,
  flattenObjects,
  point,
  type FontInfo,
} from '@garnet/pdf-content';
/** Some PDF subsets have a cmap indexed by PDF codes instead of Unicode. Restore
 * a Unicode cmap on an in-memory shaping copy only; never modify the embedded font.
 * The existing cmap and the PDF widths must independently agree on every GID. */
export function subsetShapingProgram(
  doc: mupdf.PDFDocument,
  info: FontInfo,
  program: Uint8Array,
  text: string,
  pageIndex = 0,
): Uint8Array | null {
  const tag = String.fromCharCode(...program.subarray(0, 4));
  if (
    info.subtype !== 'TrueType' ||
    !info.subset ||
    !['\u0000\u0001\u0000\u0000', 'true'].includes(tag)
  )
    return null;
  const font = new mupdf.Font('Subset validation', program),
    mapping = new Map<number, number>();
  const model = interpretPage(doc, pageIndex);
  const candidates = flattenObjects(model.objects).flatMap((r) =>
    r.kind === 'text' && r.fontKey === info.key
      ? r.glyphs.map((g) => ({ g, position: point(g.origin, model.userToPage) }))
      : [],
  );
  const observed = new Map<number, number>();
  const visit = (drawing: mupdf.Text, ctm: mupdf.Matrix) =>
    drawing.walk({
      showGlyph(_font, trm, gid, unicode) {
        if (gid <= 0 || unicode < 0 || _font.getName().replace(/^[A-Z]{6}\+/, '') !== info.baseName)
          return;
        const position = point([trm[4], trm[5]], ctm);
        const match = candidates.find(
          (c) =>
            c.g.unicode === String.fromCodePoint(unicode) &&
            Math.hypot(c.position[0] - position[0], c.position[1] - position[1]) < 0.5,
        );
        if (match) {
          const prior = observed.get(unicode);
          observed.set(unicode, prior !== undefined && prior !== gid ? -1 : gid);
        }
      },
    });
  const device = new mupdf.Device({
      fillText: visit,
      ignoreText: visit,
      strokeText: (text, _stroke, ctm) => visit(text, ctm),
    }),
    page = doc.loadPage(pageIndex);
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    device.close();
    device.destroy();
    page.destroy();
  }
  try {
    for (const char of new Set([...text])) {
      const e = encodeText(doc, info, char);
      if (e.missing.length || e.codes.length !== 1) return null;
      const gid = observed.get(char.codePointAt(0)!) ?? font.encodeCharacter(e.codes[0]);
      if (
        !gid ||
        gid < 0 ||
        Math.abs(font.advanceGlyph(gid) * 1000 - measureCodes(doc, info, e.codes, 1000)) > 2
      )
        return null;
      mapping.set(char.codePointAt(0)!, gid);
    }
  } finally {
    font.destroy();
  }
  const src = new DataView(program.buffer, program.byteOffset, program.byteLength),
    count = src.getUint16(4),
    tables: Array<{ tag: number; data: Uint8Array }> = [];
  if (12 + 16 * count > program.length) return null;
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16,
      tag = src.getUint32(at),
      offset = src.getUint32(at + 8),
      len = src.getUint32(at + 12);
    if (offset + len > program.length) return null;
    if (tag !== 0x636d6170) tables.push({ tag, data: program.slice(offset, offset + len) });
  }
  // PDF TrueType subsets may omit OS/2, which browsers require even though
  // MuPDF and HarfBuzz can use the outlines. Supply display metrics from the
  // original hhea/head tables on this disposable copy, without changing GIDs.
  if (!tables.some((t) => t.tag === 0x4f532f32)) {
    const hhea = tables.find((t) => t.tag === 0x68686561)?.data,
      head = tables.find((t) => t.tag === 0x68656164)?.data;
    if (!hhea || hhea.length < 36 || !head || head.length < 54) return null;
    const h = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength),
      hd = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const os2 = new Uint8Array(78),
      v = new DataView(os2.buffer),
      upem = hd.getUint16(18);
    v.setInt16(2, Math.round(upem / 2));
    v.setUint16(4, info.bold ? 700 : 400);
    v.setUint16(6, 5);
    v.setUint16(8, 4); // Preview-and-print use of the disposable browser copy.
    for (const at of [10, 12, 18, 20]) v.setInt16(at, Math.round(upem * 0.65));
    v.setInt16(16, Math.round(upem * 0.075));
    v.setInt16(24, Math.round(upem * 0.35));
    v.setInt16(26, Math.max(1, Math.round(upem * 0.05)));
    v.setInt16(28, Math.round(upem * 0.3));
    v.setUint32(58, 0x53414846);
    v.setUint16(
      62,
      (info.italic ? 1 : 0) | (info.bold ? 32 : 0) | (!info.bold && !info.italic ? 64 : 0),
    );
    const codes = [...mapping.keys()];
    v.setUint16(64, Math.min(65535, ...codes));
    v.setUint16(66, Math.min(65535, Math.max(...codes)));
    v.setInt16(68, h.getInt16(4));
    v.setInt16(70, h.getInt16(6));
    v.setInt16(72, h.getInt16(8));
    v.setUint16(74, Math.max(0, h.getInt16(4)));
    v.setUint16(76, Math.max(0, -h.getInt16(6)));
    tables.push({ tag: 0x4f532f32, data: os2 });
  }
  const cmap = new Uint8Array(28 + 12 * mapping.size),
    cm = new DataView(cmap.buffer);
  cm.setUint16(2, 1);
  cm.setUint16(4, 3);
  cm.setUint16(6, 10);
  cm.setUint32(8, 12);
  cm.setUint16(12, 12);
  cm.setUint32(16, cmap.length - 12);
  cm.setUint32(24, mapping.size);
  [...mapping]
    .sort((a, b) => a[0] - b[0])
    .forEach(([code, gid], i) => {
      cm.setUint32(28 + i * 12, code);
      cm.setUint32(32 + i * 12, code);
      cm.setUint32(36 + i * 12, gid);
    });
  tables.push({ tag: 0x636d6170, data: cmap });
  tables.sort((a, b) => a.tag - b.tag);
  const offset = 12 + 16 * tables.length,
    out = new Uint8Array(offset + tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), 0)),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  const power = 2 ** Math.floor(Math.log2(tables.length));
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, tables.length * 16 - power * 16);
  let cursor = offset,
    head = 0;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i],
      at = 12 + i * 16;
    out.set(t.data, cursor);
    if (t.tag === 0x68656164) {
      head = cursor;
      view.setUint32(cursor + 8, 0);
    }
    let sum = 0;
    for (let j = 0; j < t.data.length; j += 4) sum = (sum + view.getUint32(cursor + j)) >>> 0;
    view.setUint32(at, t.tag);
    view.setUint32(at + 4, sum);
    view.setUint32(at + 8, cursor);
    view.setUint32(at + 12, t.data.length);
    cursor += (t.data.length + 3) & ~3;
  }
  if (head) {
    let sum = 0;
    for (let j = 0; j < out.length; j += 4) sum = (sum + view.getUint32(j)) >>> 0;
    view.setUint32(head + 8, (0xb1b0afba - sum) >>> 0);
  }
  return out;
}
