import type { ContentOperation, ContentStreamModel, PDFDict, PDFName, PDFString, PDFValue } from './types.js';
import { Inflate } from 'pako';

const enc = new TextEncoder();
const ws = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const hex = (c: number) => c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
const digit = (c: number) => c >= 48 && c <= 57;
const delimiter = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const regularEnd = (c: number) => c < 0 || ws(c) || delimiter(c);
const nameEsc = (s: string) => s.replace(/[^!-~]|[#%()/<>\[\]{}]/g, c => '#' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

/** PDF name value, or an empty string for a non-name. */
export function name(value: PDFValue | undefined): string {
  return value && typeof value === 'object' && !Array.isArray(value) && value.type === 'name' ? value.value : '';
}

/** Produce a valid PDF operand. Strings are hex encoded to preserve arbitrary bytes. */
export function serializeValue(v: PDFValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(serializeValue).join(' ') + ']';
  if (v.type === 'name') return '/' + nameEsc(v.value);
  if (v.type === 'string') return '<' + [...v.bytes].map(c => c.toString(16).toUpperCase().padStart(2, '0')).join('') + '>';
  return '<<' + Object.entries(v.entries).map(([k, val]) => '/' + nameEsc(k) + ' ' + serializeValue(val)).join(' ') + '>>';
}

class Lexer {
  pos = 0;
  readonly warnings: string[] = [];
  constructor(readonly bytes: Uint8Array) {}
  private warn(message: string) { if (this.warnings.length < 100) this.warnings.push(`${message} at byte ${this.pos}`); }
  skip(): void {
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos];
      if (ws(c)) { this.pos++; continue; }
      if (c === 37) {
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 10 && this.bytes[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  }
  token(depth = 0): PDFValue | string | undefined {
    this.skip();
    if (this.pos >= this.bytes.length) return undefined;
    if (depth > 64) { this.warn('Nesting limit exceeded'); this.pos++; return undefined; }
    const b = this.bytes;
    const first = b[this.pos++];
    if (first === 47) {
      let s = '';
      while (this.pos < b.length && !regularEnd(b[this.pos])) {
        const c = b[this.pos++];
        if (c === 35 && this.pos + 1 < b.length) {
          const a = hex(b[this.pos]), d = hex(b[this.pos + 1]);
          if (a >= 0 && d >= 0) { s += String.fromCharCode(a * 16 + d); this.pos += 2; continue; }
        }
        s += String.fromCharCode(c);
      }
      return { type: 'name', value: s } satisfies PDFName;
    }
    if (first === 40) return this.literal();
    if (first === 60) {
      if (b[this.pos] === 60) { this.pos++; return this.dict(depth + 1); }
      const out: number[] = []; let hi = -1; let closed = false;
      while (this.pos < b.length) {
        const c = b[this.pos++];
        if (c === 62) { closed = true; break; }
        if (ws(c)) continue;
        const d = hex(c);
        if (d < 0) { this.warn('Invalid hex-string character'); continue; }
        if (hi < 0) hi = d; else { out.push(hi * 16 + d); hi = -1; }
      }
      if (hi >= 0) out.push(hi * 16);
      if (!closed) this.warn('Truncated hex string');
      return { type: 'string', bytes: Uint8Array.from(out) } satisfies PDFString;
    }
    if (first === 91) {
      const out: PDFValue[] = []; let closed = false;
      while (this.pos < b.length) {
        this.skip();
        if (b[this.pos] === 93) { this.pos++; closed = true; break; }
        const before = this.pos;
        const v = this.token(depth + 1);
        if (v !== undefined) out.push(typeof v === 'string' ? { type: 'name', value: v } : v);
        if (this.pos <= before) this.pos++;
      }
      if (!closed) this.warn('Truncated array');
      return out;
    }
    if (first === 93 || first === 62 || first === 41) { this.warn('Unexpected closing delimiter'); return undefined; }
    if (first === 123 || first === 125) { this.warn('Unexpected brace'); return undefined; }
    let s = String.fromCharCode(first);
    while (this.pos < b.length && !regularEnd(b[this.pos])) s += String.fromCharCode(b[this.pos++]);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return Number(s);
    const joined = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-z*'"].*)$/.exec(s);
    if (joined && knownOps.has(joined[2])) { this.pos -= joined[2].length; return Number(joined[1]); }
    return s;
  }
  private literal(): PDFString {
    const b = this.bytes, out: number[] = []; let nest = 1;
    while (this.pos < b.length && nest) {
      let c = b[this.pos++];
      if (c === 92) {
        if (this.pos >= b.length) break;
        c = b[this.pos++];
        if (c === 10) continue;
        if (c === 13) { if (b[this.pos] === 10) this.pos++; continue; }
        const esc: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (c in esc) { out.push(esc[c]); continue; }
        if (c >= 48 && c <= 55) {
          let oct = c - 48;
          for (let n = 0; n < 2 && this.pos < b.length && b[this.pos] >= 48 && b[this.pos] <= 55; n++) oct = oct * 8 + b[this.pos++] - 48;
          out.push(oct & 255); continue;
        }
        out.push(c); continue;
      }
      if (c === 40) nest++;
      if (c === 41) { nest--; if (!nest) break; }
      if (c === 13) { if (b[this.pos] === 10) this.pos++; c = 10; }
      out.push(c);
    }
    if (nest) this.warn('Truncated literal string');
    return { type: 'string', bytes: Uint8Array.from(out) };
  }
  private dict(depth: number): PDFDict {
    const entries: Record<string, PDFValue> = Object.create(null); let closed = false;
    while (this.pos < this.bytes.length) {
      this.skip();
      if (this.bytes[this.pos] === 62 && this.bytes[this.pos + 1] === 62) { this.pos += 2; closed = true; break; }
      const before = this.pos;
      const k = this.token(depth);
      if (typeof k !== 'object' || k === null || Array.isArray(k) || k.type !== 'name') {
        this.warn('Dictionary key is not a name');
        if (this.pos <= before) this.pos++;
        continue;
      }
      const value = this.token(depth);
      if (value === undefined) { this.warn('Dictionary value missing'); break; }
      entries[k.value] = typeof value === 'string' ? { type: 'name', value } : value;
    }
    if (!closed) this.warn('Truncated dictionary');
    return { type: 'dict', entries };
  }
}

const inlineNames: Record<string, string> = {
  BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height',
  IM: 'ImageMask', I: 'Interpolate', W: 'Width', G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK',
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode', DCT: 'DCTDecode', JPX: 'JPXDecode', L: 'Length'
};
const knownOps = new Set(('q Q cm w J j M d ri i gs BT ET Tf Tm Td TD T* Tc Tw Tz TL Ts Tr Tj TJ \' " g G rg RG k K cs CS sc SC scn SCN m l c v y h re S s f F f* B B* b b* n W W* Do sh BMC BDC EMC BX EX MP DP BI ID EI d0 d1').split(' '));

function rawLength(dict: Record<string, PDFValue>): number | null {
  const filter = dict.Filter ?? dict.F;
  if (filter !== undefined) return null;
  const w = Number(dict.Width ?? dict.W), h = Number(dict.Height ?? dict.H);
  const bpc = Number(dict.BitsPerComponent ?? dict.BPC ?? ((dict.ImageMask ?? dict.IM) === true ? 1 : 8));
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || !Number.isSafeInteger(bpc) || w <= 0 || h <= 0 || w > 100000 || h > 100000 || bpc < 1 || bpc > 16) return null;
  const colorValue = dict.ColorSpace ?? dict.CS;
  const cs = name(Array.isArray(colorValue) ? colorValue[0] : colorValue);
  const color = inlineNames[cs] ?? cs;
  const components = (dict.ImageMask ?? dict.IM) === true ? 1
    : color === 'DeviceRGB' ? 3 : color === 'DeviceCMYK' ? 4
      : color === 'DeviceGray' || color === 'Indexed' ? 1 : null;
  if (components === null) return null;
  return Math.ceil(w * components * bpc / 8) * h;
}

type InlineBoundary = { end: number; trusted: boolean; reason?: string };

function filterName(dict: Record<string, PDFValue>): string {
  const value = dict.Filter ?? dict.F;
  const first = Array.isArray(value) ? value[0] : value;
  const short = name(first);
  return inlineNames[short] ?? short;
}

/** JPEG marker walk: segment payloads may contain FF D9 and are never entropy data. */
function jpegEnd(bytes: Uint8Array, start: number): number | null {
  if (bytes[start] !== 255 || bytes[start + 1] !== 216) return null;
  let p = start + 2, entropy = false;
  while (p < bytes.length) {
    if (bytes[p++] !== 255) {
      if (entropy) continue;
      return null;
    }
    while (bytes[p] === 255) p++;
    const marker = bytes[p++];
    if (marker === undefined) return null;
    if (entropy && (marker === 0 || (marker >= 208 && marker <= 215))) continue;
    if (marker === 217) return p;
    if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) {
      if (entropy) return null;
      continue;
    }
    if (p + 1 >= bytes.length) return null;
    const length = bytes[p] * 256 + bytes[p + 1];
    if (length < 2 || p + length > bytes.length) return null;
    p += length;
    entropy = marker === 218;
  }
  return null;
}

/** Length is the encoded data length; it never includes the separator before EI. */
function encodedEnd(bytes: Uint8Array, start: number, dict: Record<string, PDFValue>): InlineBoundary | null {
  const length = dict.Length ?? dict.L;
  if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 && start + length <= bytes.length)
    return { end: start + length, trusted: true };
  const filter = filterName(dict);
  if (!filter) {
    const length = rawLength(dict);
    return length !== null && start + length <= bytes.length ? { end: start + length, trusted: true } : null;
  }
  if (filter === 'ASCIIHexDecode') {
    for (let p = start; p < bytes.length; p++) if (bytes[p] === 62) return { end: p + 1, trusted: true };
  } else if (filter === 'ASCII85Decode') {
    for (let p = start; p + 1 < bytes.length; p++) if (bytes[p] === 126 && bytes[p + 1] === 62) return { end: p + 2, trusted: true };
  } else if (filter === 'DCTDecode') {
    const end = jpegEnd(bytes, start);
    if (end !== null) return { end, trusted: true };
  } else if (filter === 'RunLengthDecode') {
    let p = start;
    while (p < bytes.length) {
      const run = bytes[p++];
      if (run === 128) return { end: p, trusted: true };
      p += run < 128 ? run + 1 : 1;
    }
  } else if (filter === 'LZWDecode') {
    const params = dict.DecodeParms ?? dict.DP;
    const early = params && typeof params === 'object' && !Array.isArray(params) && params.type === 'dict' && params.entries.EarlyChange === 0 ? 0 : 1;
    let bit = start * 8, width = 9, next = 258, prior = false;
    while (bit + width <= bytes.length * 8) {
      let code = 0;
      for (let i = 0; i < width; i++) code = (code << 1) | ((bytes[bit + i >> 3] >> (7 - ((bit + i) & 7))) & 1);
      bit += width;
      if (code === 257) return { end: Math.ceil(bit / 8), trusted: true };
      if (code === 256) { width = 9; next = 258; prior = false; continue; }
      if (code > next || (code === next && !prior)) break;
      if (prior && next < 4096) {
        next++;
        if (next + early === 1 << width && width < 12) width++;
      }
      prior = true;
    }
  } else if (filter === 'FlateDecode') {
    // Feed a byte at a time: the decoder's end flag identifies the exact zlib
    // boundary, even when compressed bytes contain an EI-shaped sequence.
    const inflate = new Inflate();
    let decoded = 0, complete = false, tooLarge = false;
    inflate.onData = chunk => {
      decoded += chunk.byteLength;
      if (decoded > 64 * 1024 * 1024) tooLarge = true;
    };
    inflate.onEnd = status => { complete = status === 0; };
    for (let p = start; p < bytes.length; p++) {
      inflate.push(bytes.subarray(p, p + 1), false);
      if (inflate.err || tooLarge) break;
      if (complete) return { end: p + 1, trusted: true };
    }
  } else {
    return { end: -1, trusted: false, reason: `Unknown inline image filter ${filter}` };
  }
  return null;
}

function inlineEI(bytes: Uint8Array, dataEnd: number): number {
  let p = dataEnd;
  if (!ws(bytes[p])) return -1;
  while (ws(bytes[p])) p++;
  return bytes[p] === 69 && bytes[p + 1] === 73 && regularEnd(bytes[p + 2] ?? -1) ? p : -1;
}

function plausibleSuffix(bytes: Uint8Array, afterEI: number): boolean {
  const lex = new Lexer(bytes); lex.pos = afterEI;
  // A binary EI lookalike is rejected unless the following bytes form a plausible content operation.
  // Validate several tokens because binary can happen to begin with one familiar operator.
  let operands = 0, operators = 0;
  for (let n = 0; n < 32; n++) {
    const t = lex.token();
    if (t === undefined) return operators > 0 || lex.pos >= bytes.length;
    if (typeof t !== 'string') { operands++; continue; }
    if (!knownOps.has(t)) return false;
    operators++; operands = 0;
    if (operators >= 2) return true;
  }
  return operators > 0 && operands === 0;
}

function inline(lex: Lexer): ContentOperation['inlineImage'] {
  const b = lex.bytes, dict: Record<string, PDFValue> = Object.create(null);
  while (lex.pos < b.length) {
    const k = lex.token();
    if (k === 'ID') break;
    if (k === undefined) continue;
    const key = name(k as PDFValue);
    if (!key) { lex.warnings.push(`Invalid inline image key at byte ${lex.pos}`); continue; }
    const v = lex.token();
    if (v === undefined) break;
    dict[inlineNames[key] ?? key] = typeof v === 'string' ? { type: 'name', value: v } : v;
  }
  // One whitespace byte separates ID from image data; CRLF counts as one separator.
  if (ws(b[lex.pos])) { const c = b[lex.pos++]; if (c === 13 && b[lex.pos] === 10) lex.pos++; }
  else lex.warnings.push(`Missing whitespace after inline ID at byte ${lex.pos}`);
  const dataStart = lex.pos, exact = encodedEnd(b, dataStart, dict);
  if (exact?.trusted) {
    const ei = inlineEI(b, exact.end);
    if (ei >= 0) {
      lex.pos = ei + 2;
      return { dict, data: b.slice(dataStart, exact.end), boundary: 'exact', editable: true } as ContentOperation['inlineImage'];
    }
    lex.warnings.push(`Inline image has no EI after exact data at byte ${exact.end}`);
  }
  // Known formats with corrupt data fail closed. A guessed boundary there can
  // expose bytes from the image as painting operators.
  if (!exact?.reason) {
    lex.warnings.push(`Inline image boundary unavailable at byte ${dataStart}`);
    lex.pos = b.length;
    return { dict, data: b.slice(dataStart), boundary: 'truncated', editable: false, reason: 'Inline image boundary unavailable' } as ContentOperation['inlineImage'];
  }
  // Only an unknown filter may use the validated heuristic.
  let chosen = -1;
  for (let p = dataStart + 1; p + 2 < b.length; p++) {
    if (!ws(b[p - 1]) || b[p] !== 69 || b[p + 1] !== 73 || !ws(b[p + 2])) continue;
    if (plausibleSuffix(b, p + 2)) { chosen = p; break; }
  }
  if (chosen < 0) {
    lex.warnings.push(`Truncated inline image at byte ${dataStart}`);
    lex.pos = b.length;
    return { dict, data: b.slice(dataStart), boundary: 'truncated', editable: false, reason: exact?.reason ?? 'Inline image boundary unavailable' } as ContentOperation['inlineImage'];
  }
  lex.pos = chosen + 2;
  const reason = exact?.reason ?? 'Inline image boundary could not be verified';
  lex.warnings.push(`${reason} at byte ${dataStart}`);
  return { dict, data: b.slice(dataStart, chosen - 1), boundary: 'heuristic', editable: false, reason } as ContentOperation['inlineImage'];
}

/** Parse a decoded PDF content stream into operations and exact byte ranges. Malformed streams remain serialisable. */
export function parseContent(bytes: Uint8Array): ContentStreamModel {
  const lex = new Lexer(bytes), operations: ContentOperation[] = [];
  let operands: PDFValue[] = [], start = 0;
  while (lex.pos < bytes.length) {
    const before = lex.pos;
    lex.skip();
    const tokenStart = lex.pos;
    const v = lex.token();
    if (v === undefined) { if (lex.pos <= before) lex.pos++; continue; }
    if (typeof v !== 'string') { if (!operands.length) start = tokenStart; operands.push(v); continue; }
    let image: ContentOperation['inlineImage'];
    if (v === 'BI') image = inline(lex);
    operations.push({ operator: v, operands, start: operands.length ? start : tokenStart, end: lex.pos, ...(image ? { inlineImage: image } : {}) });
    operands = [];
  }
  if (operands.length) lex.warnings.push(`Trailing operands at byte ${start}`);
  return { bytes, operations, tailStart: operations.at(-1)?.end ?? 0, warnings: lex.warnings };
}

/** Retain all untouched bytes, including comments and whitespace between operations. */
export function serializeContent(model: ContentStreamModel): Uint8Array {
  const chunks: Uint8Array[] = []; let last = 0, length = 0;
  for (const op of model.operations) {
    if (op.start < last || op.end < op.start || op.end > model.bytes.length) throw new Error('Overlapping content operation ranges');
    if (op.start > last) { const gap = model.bytes.subarray(last, op.start); chunks.push(gap); length += gap.length; }
    const chunk = op.replacement ?? model.bytes.subarray(op.start, op.end);
    chunks.push(chunk); length += chunk.length; last = op.end;
  }
  if (last < model.bytes.length) { const tail = model.bytes.subarray(last); chunks.push(tail); length += tail.length; }
  const out = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** UTF-8 bytes for a newly written operation. Callers handle graphics-state placement. */
export function operation(operator: string, operands: PDFValue[]): Uint8Array {
  return enc.encode(operands.map(serializeValue).join(' ') + (operands.length ? ' ' : '') + operator);
}
