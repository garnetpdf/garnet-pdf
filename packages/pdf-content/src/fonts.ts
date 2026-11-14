import type { PDFDocument, PDFObject } from 'mupdf';
import { Font as StandardFont, Encodings, FontNames } from '@pdf-lib/standard-fonts';
import type { FontInfo } from './types.js';

/** Decoded resource paired with its PDF metadata. Widths use 1000/em. */
export interface FontData {
  info: FontInfo;
  decode(bytes: Uint8Array): { code: number; cid: number; unicode: string; byteLength: number }[];
  width(code: number): number;
  vertical(code: number): { advance: number; x: number; y: number };
  editable: boolean;
  oneToOne(code: number): boolean;
  codeBytes(code: number): Uint8Array;
}
const cache = new WeakMap<PDFDocument, Map<string, FontData>>();
const reverse = new WeakMap<FontData, Map<string, number>>();
export function invalidateFontCache(doc: PDFDocument): void { cache.delete(doc); }
const resolved = (x: PDFObject) => x.isNull() || x.isStream() ? x : x.resolve();
const get = (x: PDFObject, k: string) => {
  if (x.isNull()) return x;
  const value = resolved(x).get(k);
  return resolved(value);
};
const n = (x: PDFObject, fallback = 0) => x.isNumber() ? x.asNumber() : fallback;
const s = (x: PDFObject) => x.isName() ? x.asName() : x.isString() ? x.asString() : '';
const raw = (x: PDFObject): Uint8Array => {
  if (!x.isStream()) return new Uint8Array();
  const buffer = x.readStream();
  try { return new Uint8Array(buffer.asUint8Array()); }
  finally { buffer.destroy(); }
};
const latin = (x: PDFObject) => new TextDecoder('latin1').decode(raw(x));
const hexBytes = (str: string) => Uint8Array.from((str.length % 2 ? str + '0' : str).match(/.{2}/g)?.map(v => parseInt(v, 16)) ?? []);
const utf16 = (hex: string): string => {
  const b = hexBytes(hex); if (!b.length) return '';
  if (b[0] === 0xfe && b[1] === 0xff) return utf16(hex.slice(4));
  if (b.length % 2) return String.fromCharCode(...b);
  const codes: number[] = []; for (let i = 0; i + 1 < b.length; i += 2) codes.push(b[i] * 256 + b[i + 1]);
  return String.fromCharCode(...codes);
};
// Some Chromium PDFs map already shaped Arabic presentation glyphs in
// ToUnicode. MuPDF's structured text normalizes these to base characters.
const logicalUnicode = (text: string): string => /[\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(text) ? text.normalize('NFKC') : text;
function toUnicodeMap(stream: PDFObject): Map<number, string> {
  const map = new Map<number, string>(); if (!stream.isStream()) return map;
  const source = latin(stream).replace(/%[^\r\n]*/g, '');
  for (const section of source.matchAll(/\d+\s+beginbfchar\s+([\s\S]*?)\s+endbfchar/g))
    for (const m of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  for (const section of source.matchAll(/\d+\s+beginbfrange\s+([\s\S]*?)\s+endbfrange/g))
    for (const m of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const first = parseInt(m[1], 16), last = Math.min(parseInt(m[2], 16), first + 65536);
      if (m[3]) { const base = BigInt('0x' + m[3]); for (let code = first; code <= last; code++) map.set(code, utf16((base + BigInt(code - first)).toString(16).padStart(m[3].length, '0'))); }
      else { const vals = [...m[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => x[1]); for (let code = first; code <= last && code - first < vals.length; code++) map.set(code, utf16(vals[code - first])); }
    }
  return map;
}
const glyphs: Record<string, string> = {space:' ',zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',hyphen:'-',minus:'−',period:'.',comma:',',colon:':',semicolon:';',exclam:'!',question:'?',parenleft:'(',parenright:')',bracketleft:'[',bracketright:']',braceleft:'{',braceright:'}',slash:'/',backslash:'\\',bar:'|',underscore:'_',quotesingle:"'",quotedbl:'"',quoteleft:'‘',quoteright:'’',quotedblleft:'“',quotedblright:'”',ampersand:'&',asterisk:'*',plus:'+',equal:'=',less:'<',greater:'>',numbersign:'#',dollar:'$',percent:'%',asciicircum:'^',asciitilde:'~',at:'@',grave:'`',acute:'´',copyright:'©',registered:'®',trademark:'™',bullet:'•',ellipsis:'…',endash:'–',emdash:'—',Euro:'€',sterling:'£',yen:'¥',cent:'¢',paragraph:'¶',section:'§',degree:'°',divide:'÷',multiply:'×',mu:'µ',AE:'Æ',ae:'æ',OE:'Œ',oe:'œ',Oslash:'Ø',oslash:'ø',Lslash:'Ł',lslash:'ł',germandbls:'ß',dotlessi:'ı',fi:'fi',fl:'fl',ffi:'ffi',ffl:'ffl',Aacute:'Á',aacute:'á',Eacute:'É',eacute:'é',Iacute:'Í',iacute:'í',Oacute:'Ó',oacute:'ó',Uacute:'Ú',uacute:'ú',Ntilde:'Ñ',ntilde:'ñ',Agrave:'À',agrave:'à',Egrave:'È',egrave:'è',Ograve:'Ò',ograve:'ò',Adieresis:'Ä',adieresis:'ä',Odieresis:'Ö',odieresis:'ö',Udieresis:'Ü',udieresis:'ü',Ccedilla:'Ç',ccedilla:'ç',Aring:'Å',aring:'å',Thorn:'Þ',thorn:'þ',Eth:'Ð',eth:'ð',Atilde:'Ã',atilde:'ã',Otilde:'Õ',otilde:'õ',Abreve:'Ă',abreve:'ă',Amacron:'Ā',amacron:'ā',Zcaron:'Ž',zcaron:'ž',Scaron:'Š',scaron:'š',Ydieresis:'Ÿ',ydieresis:'ÿ',alpha:'α',beta:'β',gamma:'γ',Delta:'Δ',Omega:'Ω',summation:'∑',integral:'∫',infinity:'∞',notequal:'≠',lessequal:'≤',greaterequal:'≥',arrowleft:'←',arrowright:'→',arrowup:'↑',arrowdown:'↓'};
function glyphUnicode(name: string): string {
  name = name.split('.')[0]; if (name.includes('_')) return name.split('_').map(glyphUnicode).join('');
  if (glyphs[name]) return glyphs[name]; if (/^[A-Za-z0-9]$/.test(name)) return name;
  if (/^uni(?:[0-9A-Fa-f]{4})+$/.test(name)) return utf16(name.slice(3));
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) { const cp = parseInt(name.slice(1), 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
  return '';
}
function simpleMap(encoding: string): { unicode: Map<number, string>; names: Map<number, string> } {
  const unicode = new Map<number, string>(), names = new Map<number, string>();
  const e = encoding === 'Symbol' ? Encodings.Symbol : encoding === 'ZapfDingbats' ? Encodings.ZapfDingbats : Encodings.WinAnsi;
  if (encoding === 'Symbol' || encoding === 'ZapfDingbats' || encoding === 'WinAnsiEncoding') {
    for (const cp of e.supportedCodePoints) { const v = e.encodeUnicodeCodePoint(cp); unicode.set(v.code, String.fromCodePoint(cp)); names.set(v.code, v.name); }
  } else if (encoding === 'MacRomanEncoding') {
    try { const d = new TextDecoder('macintosh'); for (let code = 0; code < 256; code++) unicode.set(code, d.decode(Uint8Array.of(code))); }
    catch { for (let code = 32; code < 127; code++) unicode.set(code, String.fromCharCode(code)); }
  } else {
    for (let code = 32; code < 127; code++) unicode.set(code, String.fromCharCode(code));
    if (encoding === 'PDFDocEncoding') {
      const special = ['•','†','‡','…','—','–','ƒ','⁄','‹','›','−','‰','„','“','”','‘','’','‚','™','ﬁ','ﬂ','Ł','Œ','Š','Ÿ','Ž','ı','ł','œ','š','ž'];
      for (let code = 128; code <= 158; code++) unicode.set(code, special[code - 128]);
      unicode.set(160, '€');
      for (let code = 161; code < 256; code++) unicode.set(code, String.fromCharCode(code));
      for (const [code, value] of ['˘','ˇ','ˆ','˙','˝','˛','˚','˜'].entries()) unicode.set(code + 24, value);
    }
  }
  return { unicode, names };
}
function differences(obj: PDFObject, unicode: Map<number, string>, names: Map<number, string>): void {
  const arr = get(obj, 'Differences'); if (!arr.isArray()) return; let code = 0;
  for (let i = 0; i < arr.length; i++) { const v = arr.get(i).resolve(); if (v.isNumber()) code = v.asNumber(); else if (v.isName()) { const name = v.asName(); names.set(code, name); unicode.set(code, glyphUnicode(name)); code++; } }
}
interface CodeRange { length: number; first: number; last: number }
function codeSpaces(obj: PDFObject): CodeRange[] {
  if (!obj.isStream()) return [{ length: 2, first: 0, last: 0xffff }];
  const ranges: CodeRange[] = [];
  for (const section of latin(obj).matchAll(/\d+\s+begincodespacerange([\s\S]*?)endcodespacerange/g))
    for (const m of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const length = m[1].length / 2;
      if (length >= 1 && length <= 4 && m[1].length === m[2].length)
        ranges.push({ length, first: parseInt(m[1], 16), last: parseInt(m[2], 16) });
    }
  return ranges.length ? ranges : [{ length: 2, first: 0, last: 0xffff }];
}
function cidMap(obj: PDFObject): Map<number, number> {
  const result = new Map<number, number>(); if (!obj.isStream()) return result; const text = latin(obj).replace(/%[^\r\n]*/g, '');
  for (const section of text.matchAll(/\d+\s+begincidchar\s+([\s\S]*?)\s+endcidchar/g))
    for (const m of section[1].matchAll(/<([0-9A-Fa-f]+)>\s+(\d+)/g)) result.set(parseInt(m[1], 16), +m[2]);
  for (const section of text.matchAll(/\d+\s+begincidrange\s+([\s\S]*?)\s+endcidrange/g))
    for (const m of section[1].matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+(\d+)/g)) { const first = parseInt(m[1], 16); for (let code = first; code <= parseInt(m[2], 16) && code - first < 65536; code++) result.set(code, +m[3] + code - first); }
  return result;
}
function cidWidths(desc: PDFObject): Map<number, number> {
  const out = new Map<number, number>(), arr = get(desc, 'W'); if (!arr.isArray()) return out;
  for (let i = 0; i < arr.length;) { const first = n(arr.get(i++).resolve()), next = arr.get(i++).resolve();
    if (next.isArray()) for (let j = 0; j < next.length; j++) out.set(first + j, n(next.get(j).resolve()));
    else if (next.isNumber()) { const width = n(arr.get(i++).resolve()); for (let code = first; code <= next.asNumber() && code - first < 65536; code++) out.set(code, width); }
    else break;
  } return out;
}
function cidVertical(desc: PDFObject): Map<number, { advance: number; x: number; y: number }> {
  const out = new Map<number, { advance: number; x: number; y: number }>(), arr = get(desc, 'W2'); if (!arr.isArray()) return out;
  for (let i = 0; i < arr.length;) { const first = n(arr.get(i++).resolve()), next = arr.get(i++).resolve();
    if (next.isArray()) for (let j = 0; j + 2 < next.length; j += 3) out.set(first + j / 3, { advance: n(next.get(j).resolve()), x: n(next.get(j + 1).resolve()), y: n(next.get(j + 2).resolve()) });
    else if (next.isNumber()) { const v = { advance: n(arr.get(i++).resolve()), x: n(arr.get(i++).resolve()), y: n(arr.get(i++).resolve()) }; for (let code = first; code <= next.asNumber() && code - first < 65536; code++) out.set(code, v); }
    else break;
  } return out;
}
const objectId = (x: PDFObject): number | null => x.isIndirect() ? x.asIndirect() : null;
function fontFile(descriptor: PDFObject): FontInfo['fontFile'] {
  if (descriptor.isNull()) return undefined;
  for (const kind of ['FontFile', 'FontFile2', 'FontFile3'] as const) { const ref = resolved(descriptor).get(kind); if (!ref.isNull()) return { kind, subtype: s(get(ref, 'Subtype')) || undefined, objNum: objectId(ref) ?? 0 }; }
  return undefined;
}
/** Resolve a /Font resource by name, retaining its original code maps and widths. */
export function resolveFont(doc: PDFDocument, ref: PDFObject, resName: string, resourceKey?: string): FontData {
  const id = objectId(ref), key = id === null ? resourceKey ?? resName : String(id);
  let byDoc = cache.get(doc); if (!byDoc) { byDoc = new Map(); cache.set(doc, byDoc); }
  const old = byDoc.get(key); if (old) { if (!old.info.resNames.includes(resName)) old.info.resNames.push(resName); return old; }
  const font = resolved(ref), subtype = (s(get(font, 'Subtype')) || 'Type1') as FontInfo['subtype'];
  const descendants = get(font, 'DescendantFonts'), desc = subtype === 'Type0' && descendants.isArray() ? descendants.get(0).resolve() : font;
  const fd0 = get(font, 'FontDescriptor'), descriptor = fd0.isNull() ? get(desc, 'FontDescriptor') : fd0;
  const rawName = s(get(font, 'BaseFont')) || s(get(desc, 'BaseFont')), subset = /^[A-Z]{6}\+/.test(rawName), baseName = rawName.replace(/^[A-Z]{6}\+/, '') || 'Unknown';
  const flags = n(get(descriptor, 'Flags')), file = fontFile(descriptor);
  const ownBox = get(font, 'FontBBox'), fdBox = get(descriptor, 'FontBBox'), fb = fdBox.isArray() ? fdBox : ownBox;
  const bbox = fb.isArray() ? Array.from({ length: 4 }, (_, i) => n(fb.get(i).resolve())) : [0, -200, 1000, 800];
  const fm = get(font, 'FontMatrix'), type3Scale = subtype === 'Type3' && fm.isArray() ? n(fm.get(3).resolve(), 0.001) * 1000 : 1;
  const encObj = get(font, 'Encoding'), embeddedEncoding = encObj.isStream() ? latin(encObj) : '';
  const enc = s(encObj) || (encObj.isDictionary() ? s(get(encObj, 'BaseEncoding')) : '') || embeddedEncoding.match(/\/CMapName\s*\/([^\s/]+)/)?.[1] || 'StandardEncoding';
  const stdName = Object.values(FontNames).includes(baseName as FontNames) ? baseName as FontNames : undefined;
  const std = stdName ? StandardFont.load(stdName) : null;
  const ascent = n(get(descriptor, 'Ascent'), n(get(descriptor, 'CapHeight'), std?.Ascender ?? bbox[3] * type3Scale));
  const descent = n(get(descriptor, 'Descent'), std?.Descender ?? bbox[1] * type3Scale);
  const info: FontInfo = { key, objNum: id, resNames: [resName], baseName, subset, subtype, cidSubtype: subtype === 'Type0' ? s(get(desc, 'Subtype')) : undefined, embedded: !!file, fontFile: file, bold: !!(flags & 0x40000) || /bold/i.test(baseName), italic: !!(flags & 0x40) || /italic|oblique/i.test(baseName), serif: !!(flags & 2) || /^Times/.test(baseName), fixedPitch: !!(flags & 1) || /^Courier/.test(baseName), ascent, descent, standard14: stdName, wmode: enc.endsWith('-V') || /\/WMode\s+1\b/.test(embeddedEncoding) ? 1 : 0, encoding: enc, hasToUnicode: get(font, 'ToUnicode').isStream() };
  const cmap = toUnicodeMap(get(font, 'ToUnicode')), simple = subtype !== 'Type0';
  const baseEnc = stdName === 'Symbol' || stdName === 'ZapfDingbats' ? stdName : enc;
  const { unicode, names } = simpleMap(baseEnc); if (simple) differences(encObj, unicode, names);
  // The AFM rows in @pdf-lib/standard-fonts start with StandardEncoding codes
  // 32..126. Without these names, a Standard-14 font without /Widths silently
  // falls back to 500 units for every glyph, shifting all subsequent origins.
  if (std && baseEnc === 'StandardEncoding') {
    for (let code = 32; code <= 126; code++) {
      const glyph = std.CharMetrics[code - 32]?.N;
      if (glyph) { names.set(code, glyph); unicode.set(code, glyphUnicode(glyph) || unicode.get(code) || ''); }
    }
  }
  if (std) {
    const glyphForUnicode = new Map<string, string>(std.CharMetrics.map(metric => [glyphUnicode(metric.N), metric.N] as [string, string]).filter(([text]) => !!text));
    for (const [code, text] of unicode) if (!names.has(code)) {
      const glyph = glyphForUnicode.get(text); if (glyph) names.set(code, glyph);
    }
  }
  const first = n(get(font, 'FirstChar')), widths = new Map<number, number>(), widthArray = get(font, 'Widths');
  if (widthArray.isArray()) for (let i = 0; i < widthArray.length; i++) widths.set(first + i, n(widthArray.get(i).resolve()));
  const units = subtype === 'Type3' && fm.isArray() ? n(fm.get(0).resolve(), 0.001) * 1000 : 1;
  const dw = n(get(desc, 'DW'), 1000), cwidth = subtype === 'Type0' ? cidWidths(desc) : new Map<number, number>();
  const vwidth = subtype === 'Type0' ? cidVertical(desc) : new Map<number, { advance: number; x: number; y: number }>();
  const dw2 = get(desc, 'DW2'), defaultV = dw2.isArray() ? { advance: n(dw2.get(1).resolve(), -1000), x: 0, y: n(dw2.get(0).resolve(), 880) } : { advance: -1000, x: 0, y: 880 };
  const spaces = codeSpaces(encObj), cid = cidMap(encObj), identity = enc === 'Identity-H' || enc === 'Identity-V' || (encObj.isStream() && /\/Identity-[HV]\s+usecmap/.test(latin(encObj)));
  const knownEncoding = /^(?:StandardEncoding|WinAnsiEncoding|MacRomanEncoding|PDFDocEncoding|Symbol|ZapfDingbats)$/.test(enc);
  const symbolicWithoutMap = simple && !!(flags & 4) && !cmap.size && (!knownEncoding || (encObj.isNull() && !std));
  const knownCMap = simple ? !symbolicWithoutMap && (knownEncoding || cmap.size > 0) : identity || (encObj.isStream() && cid.size > 0);
  function matchedCode(bytes: Uint8Array, offset: number): { code: number; length: number } {
    for (const space of [...spaces].sort((a, b) => b.length - a.length)) {
      if (offset + space.length > bytes.length) continue;
      let code = 0; for (let j = 0; j < space.length; j++) code = code * 256 + bytes[offset + j];
      if (code >= space.first && code <= space.last) return { code, length: space.length };
    }
    return { code: bytes[offset], length: 1 };
  }
  const mappingCounts = new Map<string, number>();
  for (const value of cmap.values()) { const text = logicalUnicode(value); mappingCounts.set(text, (mappingCounts.get(text) ?? 0) + 1); }
  const data: FontData = {
    info, editable: subtype !== 'Type3' && knownCMap,
    oneToOne(code) { if (!info.hasToUnicode) return true; const raw = cmap.get(code); if (!raw) return false; const text = logicalUnicode(raw); return [...raw].length === 1 && [...text].length === 1 && mappingCounts.get(text) === 1; },
    decode(bytes) { const out = []; for (let i = 0; i < bytes.length;) { const found = simple ? { code: bytes[i], length: 1 } : matchedCode(bytes, i); const { code, length } = found; i += length; const uni = cmap.get(code) ?? (simple && !symbolicWithoutMap ? unicode.get(code) ?? '' : ''); out.push({ code, cid: simple ? code : cid.get(code) ?? code, unicode: logicalUnicode(uni), byteLength: length }); } return out; },
    width(code) { if (!simple) return cwidth.get(cid.get(code) ?? code) ?? dw; const explicit = widths.get(code); if (explicit !== undefined) return explicit * units; if (std) { const glyph = names.get(code); const found = glyph ? std.getWidthOfGlyph(glyph) : undefined; if (found !== undefined) return found; } return n(get(descriptor, 'MissingWidth'), 500); },
    vertical(code) { return vwidth.get(cid.get(code) ?? code) ?? { ...defaultV, x: this.width(code) / 2 }; },
    codeBytes(code) { if (simple) return Uint8Array.of(code & 255); const space = [...spaces].sort((a, b) => a.length - b.length).find(r => code >= r.first && code <= r.last); const len = space?.length ?? 2, out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = code & 255; code >>>= 8; } return out; }
  };
  const rev = new Map<string, number>(); for (const [code, text] of cmap) if (text) { if (!rev.has(text)) rev.set(text, code); const logical = logicalUnicode(text); if (!rev.has(logical)) rev.set(logical, code); }
  // A ToUnicode map is the authority for an embedded/subset font. Generic
  // Encoding aliases cannot prove an extra glyph exists in that subset.
  if (simple && !cmap.size) for (const [code, text] of unicode)
    if (text && !rev.has(text) && (!subset || (widths.has(code) && names.has(code)))) rev.set(text, code);
  reverse.set(data, rev); byDoc.set(key, data); return data;
}
export function getFontProgram(doc: PDFDocument, font: FontInfo): Uint8Array | null {
  const id = font.fontFile?.objNum; if (!id) return null; const stream = doc.newIndirect(id);
  return stream.isStream() ? raw(stream) : null;
}
export function encodeText(doc: PDFDocument, font: FontInfo, text: string): { codes: number[]; bytes: Uint8Array; missing: string[] } {
  const data = cache.get(doc)?.get(font.key); if (!data) return { codes: [], bytes: new Uint8Array(), missing: [...text] };
  const rev = reverse.get(data) ?? new Map(), keys = [...rev.keys()].sort((a, b) => b.length - a.length), codes: number[] = [], missing: string[] = [];
  for (let i = 0; i < text.length;) { const match = keys.find(k => text.startsWith(k, i)); if (match) { codes.push(rev.get(match)!); i += match.length; } else { const cp = String.fromCodePoint(text.codePointAt(i)!); missing.push(cp); i += cp.length; } }
  return { codes, bytes: Uint8Array.from(codes.flatMap(code => [...data.codeBytes(code)])), missing };
}
export function measureCodes(doc: PDFDocument, font: FontInfo, codes: number[], size: number, charSpacing = 0, wordSpacing = 0, hScale = 100): number {
  const data = cache.get(doc)?.get(font.key); if (!data) throw new Error(`Font ${font.key} was not resolved`);
  if (font.wmode) return codes.reduce((total, code) => total + (-data.vertical(code).advance / 1000 * size + charSpacing), 0);
  return codes.reduce((total, code) => total + (data.width(code) / 1000 * size + charSpacing + (code === 32 && data.codeBytes(code).length === 1 ? wordSpacing : 0)) * hScale / 100, 0);
}
