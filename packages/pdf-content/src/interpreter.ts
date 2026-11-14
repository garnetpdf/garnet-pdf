import * as mupdf from 'mupdf';
import type { BaseObj, ContentStreamModel, FontInfo, Glyph, Matrix, PageModel, PageObject, PDFValue, Point, Rect, RGB, TextRun } from './types.js';
import { IDENTITY, bounds, concat, expand, intersect, invert, point, transformRect, translate, union } from './geometry.js';
import { parseContent, serializeValue } from './parser.js';
import { resolveFont, type FontData } from './fonts.js';
export interface GraphicsState {
    ctm: Matrix;
    lineWidth: number;
    lineCap: number;
    lineJoin: number;
    miter: number;
    dash: number[];
    dashPhase: number;
    fill: RGB;
    stroke: RGB;
    fillSpace: string;
    strokeSpace: string;
    fillCommand: string;
    strokeCommand: string;
    fillAlpha: number;
    strokeAlpha: number;
    font?: FontData;
    fontResName: string;
    size: number;
    charSpacing: number;
    wordSpacing: number;
    hScale: number;
    rise: number;
    leading: number;
    renderMode: number;
    tm: Matrix;
    lm: Matrix;
    inText: boolean;
    clip?: Rect;
    /** Shared between state copies: never changed in place, a new array replaces it (copy on write). */
    clips: readonly string[];
    /** Shared between state copies, like `clips`. */
    extStates: readonly string[];
    /** Serial number of the current graphics, text, clip or marked-content scope; a new number per scope event. */
    scope: number;
    maskBBox?: Rect;
}
export interface Source {
    ref: mupdf.PDFObject;
    parsed: ContentStreamModel;
    resources: mupdf.PDFObject;
    index: number;
    tag: string;
    parent?: {
        source: Source;
        op: number;
        name: string;
        ref: mupdf.PDFObject;
    };
    formPath: string[];
    initialCTM: Matrix;
    parts?: { ref: mupdf.PDFObject; start: number; end: number; index: number }[];
}
export interface ObjectDetail {
    source: Source;
    before: GraphicsState;
    after: GraphicsState;
    object: PageObject;
    pathOps?: number[];
    hasClip?: boolean;
    pathCommands?: string;
    /** Offsets in `pathCommands` where a rectangle written with `re` starts (as m, l, l, l, h). */
    pathRects?: number[];
    scope: string;
    textBlock?: [number, number];
}
export interface PageDetails {
    sources: Source[];
    objects: Map<string, ObjectDetail>;
    endState: GraphicsState;
    stackDepth: number;
}
const details = new WeakMap<PageModel, PageDetails>();
export function getPageDetails(model: PageModel): PageDetails {
    const d = details.get(model);
    if (!d)
        throw new Error('Model was not created by interpretPage');
    return d;
}
export function flattenObjects(objects: PageObject[]): PageObject[] {
    return objects.flatMap(o => o.kind === 'form' ? [o, ...flattenObjects(o.children)] : [o]);
}
export function copyState(s: GraphicsState): GraphicsState {
    return { ...s, ctm: [...s.ctm], tm: [...s.tm], lm: [...s.lm], fill: [...s.fill], stroke: [...s.stroke], dash: [...s.dash], clip: s.clip && [...s.clip] };
}
export function streamBytes(ref: mupdf.PDFObject): Uint8Array { const b = ref.readStream(); try {
    return b.asUint8Array().slice();
}
finally {
    b.destroy();
} }
export function contentRefs(page: mupdf.PDFObject): mupdf.PDFObject[] {
    const c = page.get('Contents');
    if (c.isNull())
        return [];
    if (!c.isArray())
        return [c];
    return Array.from({ length: c.length }, (_, i) => c.get(i));
}
function num(v: PDFValue | undefined, fallback = 0): number { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function nm(v: PDFValue | undefined): string { return v && !Array.isArray(v) && typeof v === 'object' && 'type' in v && v.type === 'name' ? v.value : ''; }
function str(v: PDFValue | undefined): Uint8Array | undefined { return v && !Array.isArray(v) && typeof v === 'object' && 'type' in v && v.type === 'string' ? v.bytes : undefined; }
function arr(obj: mupdf.PDFObject, fallback: number[]): number[] { return obj.isArray() ? Array.from({ length: obj.length }, (_, i) => obj.get(i).asNumber()) : fallback; }
export function decodePDFText(bytes: Uint8Array): string {
    if (bytes[0] === 254 && bytes[1] === 255) {
        let s = '';
        for (let i = 2; i + 1 < bytes.length; i += 2)
            s += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
        return s;
    }
    if (bytes[0] === 255 && bytes[1] === 254)
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191)
        return new TextDecoder().decode(bytes.subarray(3));
    const special = ['•', '†', '‡', '…', '—', '–', 'ƒ', '⁄', '‹', '›', '−', '‰', '„', '“', '”', '‘', '’', '‚', '™', 'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š', 'Ÿ', 'Ž', 'ı', 'ł', 'œ', 'š', 'ž'];
    const accents = ['˘', 'ˇ', 'ˆ', '˙', '˝', '˛', '˚', '˜'];
    return Array.from(bytes, b => b >= 24 && b <= 31 ? accents[b - 24] : b >= 128 && b <= 158 ? special[b - 128] : b === 160 ? '€' : b === 127 || b === 159 || b === 173 ? '\uFFFD' : String.fromCharCode(b)).join('');
}
function rgb(values: number[], space: string): RGB {
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    if (space === 'DeviceCMYK' || space === 'CMYK' || values.length === 4) {
        const [c = 0, m = 0, y = 0, k = 0] = values;
        return [1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)];
    }
    if (values.length >= 3)
        return values.slice(0, 3).map(clamp) as RGB;
    return [clamp(values[0] ?? 0), clamp(values[0] ?? 0), clamp(values[0] ?? 0)];
}
function initial(): GraphicsState { return { ctm: [...IDENTITY], lineWidth: 1, lineCap: 0, lineJoin: 0, miter: 10, dash: [], dashPhase: 0, fill: [0, 0, 0], stroke: [0, 0, 0], fillSpace: 'DeviceGray', strokeSpace: 'DeviceGray', fillCommand: '0 g', strokeCommand: '0 G', fillAlpha: 1, strokeAlpha: 1, fontResName: '', size: 0, charSpacing: 0, wordSpacing: 0, hScale: 100, rise: 0, leading: 0, renderMode: 0, tm: [...IDENTITY], lm: [...IDENTITY], inText: false, clips: [], extStates: [], scope: 0 }; }
export interface InterpretOptions {
    maxFormDepth?: number; /** Enable MuPDF fallback only for unsupported CMaps. Default true. */
    fallback?: boolean;
}
/** Interpret content operators independently of MuPDF's text extraction, in PDF user space. */
export function interpretPage(doc: mupdf.PDFDocument, pageIndex: number, opts: InterpretOptions = {}): PageModel {
    const page = doc.loadPage(pageIndex), pobj = page.getObject(), userToPage = page.getTransform();
    const mediaBox = arr(pobj.getInheritable('MediaBox'), [0, 0, 612, 792]) as Rect;
    const cropBox = arr(pobj.getInheritable('CropBox'), mediaBox) as Rect;
    const rotation = ((pobj.getInheritable('Rotate').asNumber() % 360) + 360) % 360;
    const model: PageModel = { revision: '', pageIndex, userToPage, mediaBox, cropBox, rotate: ([0, 90, 180, 270].includes(rotation) ? rotation : 0) as PageModel['rotate'], streams: [], objects: [], fonts: {}, warnings: [] };
    const meta: PageDetails = { sources: [], objects: new Map(), endState: initial(), stackDepth: 0 };
    details.set(model, meta);
    const warn = (s: string) => { if (!model.warnings.includes(s))
        model.warnings.push(s); };
    let z = 0;
    const pageRefs = contentRefs(pobj);
    const marked: {
        tag: string;
        actual?: string;
        span?: string;
    }[] = [];
    const stack: GraphicsState[] = [];
    let state = initial();
    // A label that grew with every scope event made each object carry a copy of the whole page's history
    // (gigabytes on a drawing with 50,000 objects); only equality is ever needed, so a serial is enough.
    let scopeSerial = 0;
    // Paths are not part of the saved graphics state and can span content streams.
    let path = new mupdf.Path(), pathSource: Source | undefined, pathOps: number[] = [], pathCommands = '', pathRects: number[] = [], segments = 0, pendingClip = false, evenClip = false;
    const resetPath = () => { path.destroy(); path = new mupdf.Path(); pathSource = undefined; pathOps = []; pathCommands = ''; pathRects = []; segments = 0; pendingClip = false; };
    const register = (obj: PageObject, src: Source, before: GraphicsState, extra: Partial<ObjectDetail> = {}) => {
        meta.objects.set(obj.id, { source: src, before, after: copyState(state), object: obj, scope: `${src.tag}/${state.scope}`, ...extra });
        return obj;
    };
    const base = (kind: string, box: Rect, src: Source, first: number, last: number): BaseObj => ({ id: `p${pageIndex}/${src.tag}/o${first}-${last}`, kind, bbox: box, renderBBox: state.maskBBox ? union(box, state.maskBBox) : [...box], editability: { move: true, delete: true, recolor: true, opacity: true, reorder: true, replace: true, crop: true }, pageBBox: transformRect(box, userToPage), ctm: [...state.ctm], z: z++, formPath: [...src.formPath], ops: { stream: src.parts?.find(p => p.end > src.parsed.operations[first].start)?.index ?? src.index, first, last, streams: src.parts?.filter(p => p.end > src.parsed.operations[first].start && p.start < src.parsed.operations[last].end).map(p => p.index) ?? [src.index] }, clipped: !!state.clip, clipBBox: state.clip ? intersect(box, state.clip) : undefined, opacity: { fill: state.fillAlpha, stroke: state.strokeAlpha }, markedContent: marked.map(m => m.tag) });
    const font = (src: Source, ref: mupdf.PDFObject, name: string) => { const f = resolveFont(doc, ref, name, `${src.tag}/${name}`); model.fonts[f.info.key] = f.info; return f; };
    function walk(src: Source, objects: PageObject[], ancestors: number[]): void {
        meta.sources.push(src);
        model.warnings.push(...src.parsed.warnings.map(w => `${src.tag}: ${w}`));
        const operations = src.parsed.operations;
        for (let i = 0; i < operations.length; i++) {
            const op = operations[i], a = op.operands, n = a.map(v => num(v)), name = nm(a[0]);
            // The state before the operator is kept with each object it creates. Only these operators create one,
            // so the copy is not made for the others (path building is most of a drawing's operators).
            const before = OBJECT_OPERATORS.has(op.operator) ? copyState(state) : state;
            try {
                switch (op.operator) {
                    case 'q':
                        stack.push(copyState(state));
                        state.scope = ++scopeSerial;
                        break;
                    case 'Q': {
                        const saved = stack.pop();
                        if (saved) {
                            const { tm, lm, inText } = state;
                            state = saved;
                            state.tm = tm;
                            state.lm = lm;
                            state.inText = inText;
                            state.scope = ++scopeSerial;
                        }
                        else
                            warn(`${src.tag}: unmatched Q`);
                        break;
                    }
                    case 'cm':
                        if (n.length >= 6)
                            state.ctm = concat(n.slice(-6) as Matrix, state.ctm);
                        break;
                    case 'w':
                        state.lineWidth = n[0];
                        break;
                    case 'J':
                        state.lineCap = n[0];
                        break;
                    case 'j':
                        state.lineJoin = n[0];
                        break;
                    case 'M':
                        state.miter = n[0];
                        break;
                    case 'd':
                        state.dash = Array.isArray(a[0]) ? a[0].map(v => num(v)) : [];
                        state.dashPhase = n[1];
                        break;
                    case 'ri':
                    case 'i': break;
                    case 'gs': {
                        state.scope = ++scopeSerial;
                        const gs = src.resources.get('ExtGState', name);
                        // Consecutive repeats of one ExtGState are idempotent; keeping one keeps the list short.
                        if (state.extStates[state.extStates.length - 1] !== name) state.extStates = [...state.extStates, name];
                        for (const [key, attr] of [['ca', 'fillAlpha'], ['CA', 'strokeAlpha'], ['LW', 'lineWidth'], ['LC', 'lineCap'], ['LJ', 'lineJoin'], ['ML', 'miter']] as const)
                            if (!gs.get(key).isNull())
                                state[attr] = gs.get(key).asNumber();
                        const f = gs.get('Font');
                        if (f.isArray()) {
                            state.fontResName = `@${name}`;
                            state.font = font(src, f.get(0), state.fontResName);
                            state.size = f.get(1).asNumber();
                        }
                        const dash = gs.get('D');
                        if (dash.isArray()) {
                            state.dash = arr(dash.get(0), []);
                            state.dashPhase = dash.get(1).asNumber();
                        }
                        if (!gs.get('SMask').isNull() && gs.get('SMask').asName() !== 'None')
                            { state.maskBBox = [...cropBox]; warn('Soft mask geometry is conservative'); }
                        break;
                    }
                    case 'BT':
                        state.scope = ++scopeSerial;
                        state.inText = true;
                        state.tm = [...IDENTITY];
                        state.lm = [...IDENTITY];
                        break;
                    case 'ET':
                        state.inText = false;
                        state.scope = ++scopeSerial;
                        break;
                    case 'Tf':
                        state.fontResName = name;
                        state.size = n[1];
                        state.font = font(src, src.resources.get('Font', name), name);
                        break;
                    case 'Tm':
                        if (n.length >= 6)
                            state.tm = state.lm = n.slice(-6) as Matrix;
                        break;
                    case 'Td':
                    case 'TD':
                        if (op.operator === 'TD')
                            state.leading = -n[1];
                        state.tm = state.lm = concat(translate(n[0], n[1]), state.lm);
                        break;
                    case 'T*':
                        state.tm = state.lm = concat(translate(0, -state.leading), state.lm);
                        break;
                    case 'Tc':
                        state.charSpacing = n[0];
                        break;
                    case 'Tw':
                        state.wordSpacing = n[0];
                        break;
                    case 'Tz':
                        state.hScale = n[0];
                        break;
                    case 'TL':
                        state.leading = n[0];
                        break;
                    case 'Ts':
                        state.rise = n[0];
                        break;
                    case 'Tr':
                        state.renderMode = n[0];
                        break;
                    case "'":
                    case '"':
                    case 'Tj':
                    case 'TJ': {
                        if (op.operator === '"') {
                            state.wordSpacing = n[0];
                            state.charSpacing = n[1];
                        }
                        if (op.operator === "'" || op.operator === '"')
                            state.tm = state.lm = concat(translate(0, -state.leading), state.lm);
                        const tm = [...state.tm] as Matrix, f = state.font;
                        if (!f) {
                            warn(`${src.tag}: text without a font`);
                            break;
                        }
                        const operand = a[a.length - 1], parts = Array.isArray(operand) ? operand : [operand];
                        const glyphs: Glyph[] = [];
                        let editable = f.editable;
                        for (const part of parts) {
                            if (typeof part === 'number') {
                                const d = -part / 1000 * state.size;
                                state.tm = concat(translate(f.info.wmode ? 0 : d * state.hScale / 100, f.info.wmode ? d : 0), state.tm);
                                continue;
                            }
                            const bytes = str(part);
                            if (!bytes)
                                continue;
                            for (const g of f.decode(bytes)) {
                                const width = f.width(g.code), v = f.vertical(g.code), hs = state.hScale / 100;
                                const adv = (width / 1000 * state.size + state.charSpacing + (g.code === 32 && g.byteLength === 1 ? state.wordSpacing : 0)) * hs;
                                const vadv = v.advance / 1000 * state.size + state.charSpacing + (g.code === 32 && g.byteLength === 1 ? state.wordSpacing : 0);
                                const charMatrix = concat(state.tm, state.ctm);
                                const x = f.info.wmode ? -v.x / 1000 * state.size * hs : 0, y = state.rise + (f.info.wmode ? -v.y / 1000 * state.size : 0);
                                const origin = point([x, y], charMatrix);
                                const box = transformRect([x, y + f.info.descent / 1000 * state.size, x + width / 1000 * state.size * hs, y + f.info.ascent / 1000 * state.size], charMatrix);
                                glyphs.push({ code: g.code, unicode: g.unicode, byteLength: g.byteLength, origin, bbox: box, advance: f.info.wmode ? vadv : adv, textMatrix: [...state.tm] });
                                if (!g.unicode)
                                    editable = false;
                                state.tm = concat(translate(f.info.wmode ? 0 : adv, f.info.wmode ? vadv : 0), state.tm);
                            }
                        }
                        const drawn = concat(tm, state.ctm);
                        const box = glyphs.length ? glyphs.map(g => g.bbox).reduce(union) : transformRect([0, 0, 0, 0], drawn);
                        const actual = [...marked].reverse().find(m => m.actual !== undefined);
                        const obj: TextRun = { ...base('text', box, src, i, i), kind: 'text', fontKey: f.info.key, fontResName: state.fontResName, size: state.size, userSize: Math.abs(state.size) * Math.hypot(drawn[2], drawn[3]), userScale: [Math.hypot(drawn[0], drawn[1]), Math.hypot(drawn[2], drawn[3])], textMatrix: tm, charSpacing: state.charSpacing, wordSpacing: state.wordSpacing, hScale: state.hScale, rise: state.rise, leading: state.leading, renderMode: state.renderMode, fill: [...state.fill], stroke: [...state.stroke], text: glyphs.map(g => g.unicode).join(''), actualText: actual?.actual, actualTextSpan: actual?.span, glyphs, editable };
                        objects.push(register(obj, src, before));
                        break;
                    }
                    case 'g':
                    case 'rg':
                    case 'k':
                        state.fillSpace = op.operator === 'g' ? 'DeviceGray' : op.operator === 'k' ? 'DeviceCMYK' : 'DeviceRGB';
                        state.fill = rgb(n, state.fillSpace);
                        state.fillCommand = `${a.map(serializeValue).join(' ')} ${op.operator}`;
                        break;
                    case 'G':
                    case 'RG':
                    case 'K':
                        state.strokeSpace = op.operator === 'G' ? 'DeviceGray' : op.operator === 'K' ? 'DeviceCMYK' : 'DeviceRGB';
                        state.stroke = rgb(n, state.strokeSpace);
                        state.strokeCommand = `${a.map(serializeValue).join(' ')} ${op.operator}`;
                        break;
                    case 'cs':
                        state.fillSpace = name;
                        state.fillCommand = `${serializeValue(a[0])} cs`;
                        break;
                    case 'CS':
                        state.strokeSpace = name;
                        state.strokeCommand = `${serializeValue(a[0])} CS`;
                        break;
                    case 'sc':
                    case 'scn':
                        state.fill = rgb(a.filter(v => typeof v === 'number') as number[], state.fillSpace);
                        state.fillCommand = `${serializeValue({ type: 'name', value: state.fillSpace })} cs ${a.map(serializeValue).join(' ')} ${op.operator}`;
                        if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(state.fillSpace))
                            warn(`Approximate colour: ${state.fillSpace}`);
                        break;
                    case 'SC':
                    case 'SCN':
                        state.stroke = rgb(a.filter(v => typeof v === 'number') as number[], state.strokeSpace);
                        state.strokeCommand = `${serializeValue({ type: 'name', value: state.strokeSpace })} CS ${a.map(serializeValue).join(' ')} ${op.operator}`;
                        if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(state.strokeSpace))
                            warn(`Approximate colour: ${state.strokeSpace}`);
                        break;
                    case 'm':
                    case 'l':
                    case 'c':
                    case 'v':
                    case 'y':
                    case 'h':
                    case 're': {
                        if (!pathSource)
                            pathSource = src;
                        pathOps.push(i);
                        segments++;
                        const p = (x: number, y: number) => point([x, y], state.ctm);
                        if (op.operator === 'm') {
                            const t = p(n[0], n[1]);
                            path.moveTo(...t);
                            pathCommands += `${t.join(' ')} m\n`;
                        }
                        if (op.operator === 'l') {
                            const t = p(n[0], n[1]);
                            path.lineTo(...t);
                            pathCommands += `${t.join(' ')} l\n`;
                        }
                        if (op.operator === 'c') {
                            const t = [...p(n[0], n[1]), ...p(n[2], n[3]), ...p(n[4], n[5])] as [
                                number,
                                number,
                                number,
                                number,
                                number,
                                number
                            ];
                            path.curveTo(...t);
                            pathCommands += `${t.join(' ')} c\n`;
                        }
                        if (op.operator === 'v' || op.operator === 'y') {
                            const t = [...p(n[0], n[1]), ...p(n[2], n[3])] as [
                                number,
                                number,
                                number,
                                number
                            ];
                            if (op.operator === 'v')
                                path.curveToV(...t);
                            else
                                path.curveToY(...t);
                            pathCommands += `${t.join(' ')} ${op.operator}\n`;
                        }
                        if (op.operator === 'h') {
                            path.closePath();
                            pathCommands += 'h\n';
                        }
                        if (op.operator === 're') {
                            const ps = [p(n[0], n[1]), p(n[0] + n[2], n[1]), p(n[0] + n[2], n[1] + n[3]), p(n[0], n[1] + n[3])];
                            path.moveTo(...ps[0]);
                            for (const t of ps.slice(1))
                                path.lineTo(...t);
                            path.closePath();
                            // Remembered, so an edit writes it back as `re`: viewers draw a zero-height `re` as a hairline
                            // but not the same shape spelled out with m and l (table rules vanished after a move).
                            pathRects.push(pathCommands.length);
                            pathCommands += `${ps[0].join(' ')} m\n${ps.slice(1).map(t => `${t.join(' ')} l`).join('\n')}\nh\n`;
                        }
                        break;
                    }
                    case 'W':
                    case 'W*':
                        pendingClip = true;
                        evenClip = op.operator === 'W*';
                        break;
                    case 'S':
                    case 's':
                    case 'f':
                    case 'F':
                    case 'f*':
                    case 'B':
                    case 'B*':
                    case 'b':
                    case 'b*':
                    case 'n': {
                        const stroke = /[SsBb]/.test(op.operator), fill = /[fFbB]/.test(op.operator);
                        if (['s', 'b', 'b*'].includes(op.operator)) {
                            path.closePath();
                            pathCommands += 'h\n';
                        }
                        const raw = path.getBounds(null as unknown as mupdf.StrokeState, IDENTITY);
                        if (op.operator !== 'n' && segments) {
                            const [a, b, c, d] = state.ctm, trace = a * a + b * b + c * c + d * d, det = a * d - b * c;
                            const scale = Math.sqrt((trace + Math.sqrt(Math.max(0, trace * trace - 4 * det * det))) / 2);
                            // MuPDF's stroke bounds conservatively use a full line width, including the miter limit.
                            const box = stroke ? expand(raw, Math.max(.5, state.lineWidth * scale) * (state.lineJoin === 0 ? Math.max(1, state.miter) : 1)) : raw;
                            const obj: PageObject = { ...base('path', box, src, pathOps[0] ?? i, i), kind: 'path', paint: { fill, stroke, evenOdd: op.operator.endsWith('*') }, fill: [...state.fill], stroke: [...state.stroke], lineWidth: state.lineWidth, segments };
                            if (pathSource !== src)
                                warn('Path crosses content stream boundaries; editing this path is unsupported');
                            objects.push(register(obj, src, before, { pathOps: [...pathOps], hasClip: pendingClip, pathCommands, pathRects: [...pathRects] }));
                        }
                        if (pendingClip) {
                            state.clip = state.clip ? intersect(state.clip, raw) : raw;
                            state.scope = ++scopeSerial;
                            state.clips = [...state.clips, `${pathCommands}${evenClip ? 'W*' : 'W'} n\n`];
                        }
                        resetPath();
                        break;
                    }
                    case 'Do': {
                        const ref = src.resources.get('XObject', name), subtype = ref.get('Subtype').asName();
                        if (subtype === 'Image') {
                            const filters = ref.get('Filter'), filter = filters.isArray() ? Array.from({ length: filters.length }, (_, j) => filters.get(j).asName()) : filters.isName() ? [filters.asName()] : [];
                            const cs = ref.get('ColorSpace');
                            const obj: PageObject = { ...base('image', transformRect([0, 0, 1, 1], state.ctm), src, i, i), kind: 'image', resName: name, objNum: ref.asIndirect(), width: ref.get('Width').asNumber(), height: ref.get('Height').asNumber(), bpc: ref.get('BitsPerComponent').asNumber(), colorSpace: cs.isName() ? cs.asName() : cs.toString(), filter, hasSMask: !ref.get('SMask').isNull(), isMask: ref.get('ImageMask').asBoolean() };
                            objects.push(register(obj, src, before));
                        }
                        else if (subtype === 'Form') {
                            const matrix = arr(ref.get('Matrix'), IDENTITY) as Matrix, ctm = concat(matrix, state.ctm), box = transformRect(arr(ref.get('BBox'), [0, 0, 0, 0]) as Rect, ctm);
                            const obj: PageObject = { ...base('form', box, src, i, i), ctm, kind: 'form', resName: name, objNum: ref.asIndirect(), children: [] };
                            objects.push(register(obj, src, before));
                            if (ancestors.includes(ref.asIndirect())) {
                                warn(`Cyclic form: ${name}`);
                                break;
                            }
                            if (ancestors.length >= Math.min(opts.maxFormDepth ?? 12, 12)) {
                                warn(`Form depth limit: ${name}`);
                                break;
                            }
                            const savedState = state, savedStack = stack.splice(0), savedMarked = [...marked];
                            const savedPath = { path, pathSource, pathOps, pathCommands, pathRects, segments, pendingClip, evenClip };
                            path = new mupdf.Path();
                            pathSource = undefined;
                            pathOps = [];
                            pathCommands = '';
                            pathRects = [];
                            segments = 0;
                            pendingClip = false;
                            state = copyState(state);
                            state.ctm = ctm;
                            state.clip = state.clip ? intersect(state.clip, box) : box;
                            state.clips = [...state.clips, `${box[0]} ${box[1]} ${box[2] - box[0]} ${box[3] - box[1]} re W n\n`];
                            try {
                                const ownRes = ref.get('Resources');
                                walk({ ref, parsed: parseContent(streamBytes(ref)), resources: ownRes.isNull() ? src.resources : ownRes, index: 0, tag: `${src.tag}/${name}@${i}`, parent: { source: src, op: i, name, ref }, formPath: [...src.formPath, name], initialCTM: ctm }, obj.children, [...ancestors, ref.asIndirect()]);
                            }
                            finally {
                                path.destroy();
                                ({ path, pathSource, pathOps, pathCommands, pathRects, segments, pendingClip, evenClip } = savedPath);
                                state = savedState;
                                stack.splice(0, stack.length, ...savedStack);
                                marked.splice(0, marked.length, ...savedMarked);
                            }
                        }
                        else
                            warn(`Unknown XObject ${name}`);
                        break;
                    }
                    case 'BI': {
                        const d = op.inlineImage?.dict ?? {}, box = transformRect([0, 0, 1, 1], state.ctm);
                        const obj: PageObject = { ...base('inline-image', box, src, i, i), kind: 'inline-image', width: num(d.Width ?? d.W), height: num(d.Height ?? d.H) };
                        objects.push(register(obj, src, before));
                        break;
                    }
                    case 'sh': {
                        const sh = src.resources.get('Shading', name), box = sh.get('BBox').isArray() ? transformRect(arr(sh.get('BBox'), cropBox) as Rect, state.ctm) : state.clip ?? cropBox;
                        objects.push(register({ ...base('shading', box, src, i, i), kind: 'shading', resName: name }, src, before));
                        break;
                    }
                    case 'BMC':
                        state.scope = ++scopeSerial;
                        marked.push({ tag: name });
                        break;
                    case 'BDC': {
                        state.scope = ++scopeSerial;
                        let actual: Uint8Array | undefined;
                        const prop = a[1];
                        if (prop && typeof prop === 'object' && !Array.isArray(prop) && prop.type === 'dict')
                            actual = str(prop.entries.ActualText);
                        else {
                            const p = src.resources.get('Properties', nm(prop)).get('ActualText');
                            if (p.isString())
                                actual = p.asByteString();
                        }
                        marked.push({ tag: name, actual: actual ? decodePDFText(actual) : undefined, span: `p${pageIndex}/${src.tag}/marked${i}` });
                        break;
                    }
                    case 'EMC':
                        state.scope = ++scopeSerial;
                        if (!marked.pop())
                            warn(`${src.tag}: unmatched EMC`);
                        break;
                    case 'MP':
                    case 'DP':
                    case 'BX':
                    case 'EX':
                    case 'd0':
                    case 'd1': break;
                    default: warn(`Unknown operator: ${op.operator}`);
                }
            }
            catch (e) {
                warn(`${src.tag} operator ${i} (${op.operator}): ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    try {
        const parts: NonNullable<Source['parts']> = [], chunks: Uint8Array[] = [];
        let offset = 0;
        pageRefs.forEach((ref, index) => {
            const bytes = streamBytes(ref);
            model.streams.push({ objNum: ref.isIndirect() ? ref.asIndirect() : null, length: bytes.length });
            parts.push({ ref, start: offset, end: offset + bytes.length, index });
            chunks.push(bytes, Uint8Array.of(10)); offset += bytes.length + 1;
        });
        if (pageRefs.length) {
            const logical = new Uint8Array(offset); let at = 0;
            for (const chunk of chunks) { logical.set(chunk, at); at += chunk.length; }
            walk({ ref: pageRefs[0], parsed: parseContent(logical), resources: pobj.getInheritable('Resources'), index: 0, tag: 's0', formPath: [], initialCTM: [...IDENTITY], parts }, model.objects, []);
        }
        harden(model, meta);
        model.revision = fingerprint(meta.sources.map(s => s.parsed.bytes));
        const objectDetails = [...meta.objects.values()]; meta.objects.clear();
        for (const d of objectDetails) { d.object.id = `r${model.revision}/${d.object.id}`; meta.objects.set(d.object.id, d); }

        meta.endState = copyState(state);
        meta.stackDepth = stack.length;
        if (stack.length)
            warn(`Page ends with ${stack.length} unbalanced q operators`);
        if (state.inText)
            warn('Page ends inside BT');
        if (opts.fallback !== false) {
            const unsupported = flattenObjects(model.objects).filter((o): o is TextRun => o.kind === 'text' && !o.editable && o.glyphs.some(g => !g.unicode));
            if (unsupported.length) {
                const chars: {
                    unicode: string;
                    origin: Point;
                    bbox: Rect;
                    used: boolean;
                }[] = [];
                const text = page.toStructuredText('preserve-whitespace,preserve-ligatures,inhibit-spaces');
                const inv = invert(userToPage);
                try {
                    text.walk({ onChar(c, o, _f, _s, q) { chars.push({ unicode: c, origin: point(o, inv), bbox: transformRect(bounds([[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]), inv), used: false }); } });
                }
                finally {
                    text.destroy();
                }
                const nearest = nearestUnused(chars);
                for (const run of unsupported) {
                    for (const g of run.glyphs) {
                        const c = nearest(g.origin, g.unicode);
                        if (c) {
                            c.used = true;
                            g.origin = c.origin;
                            g.bbox = c.bbox;
                            g.unicode = c.unicode;
                        }
                    }
                    run.text = run.glyphs.map(g => g.unicode).join('');
                    if (run.glyphs.length) {
                        run.bbox = run.glyphs.map(g => g.bbox).reduce(union);
                        run.pageBBox = transformRect(run.bbox, userToPage);
                    }
                }
                warn('Unsupported font codes use MuPDF structured-text fallback; these runs are not editable');
            }
        }
        return model;
    }
    finally {
        path.destroy();
        page.destroy();
    }
}

/**
 * Finds, for a point, the nearest character that is not used yet (and has the wanted Unicode value, when one is
 * given); on equal distance the earlier character wins. Same choice as filtering and sorting every character
 * for every glyph, but through a grid, so a page of unmapped glyphs no longer costs glyphs x characters.
 */
function nearestUnused<T extends { unicode: string; origin: Point; used: boolean }>(chars: T[]): (at: Point, unicode: string) => T | undefined {
    const CELL = 24;
    const grid = new Map<string, number[]>();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const cell = (v: number) => Math.floor(v / CELL);
    chars.forEach((c, index) => {
        const x = cell(c.origin[0]), y = cell(c.origin[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const key = `${x},${y}`, list = grid.get(key);
        if (list) list.push(index); else grid.set(key, [index]);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    });
    return (at, unicode) => {
        if (!grid.size || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return undefined;
        const cx = cell(at[0]), cy = cell(at[1]);
        const reach = Math.max(Math.abs(cx - minX), Math.abs(cx - maxX), Math.abs(cy - minY), Math.abs(cy - maxY));
        let best = -1, bestDistance = Infinity;
        const visit = (x: number, y: number) => {
            const list = grid.get(`${x},${y}`);
            if (!list) return;
            for (const index of list) {
                const c = chars[index];
                if (c.used || (unicode && unicode !== c.unicode)) continue;
                const distance = Math.hypot(c.origin[0] - at[0], c.origin[1] - at[1]);
                if (distance < bestDistance || (distance === bestDistance && index < best)) { best = index; bestDistance = distance; }
            }
        };
        for (let ring = 0; ring <= reach; ring++) {
            if (ring === 0) visit(cx, cy);
            else {
                for (let x = cx - ring; x <= cx + ring; x++) { visit(x, cy - ring); visit(x, cy + ring); }
                for (let y = cy - ring + 1; y <= cy + ring - 1; y++) { visit(cx - ring, y); visit(cx + ring, y); }
            }
            // Every character outside the rings visited so far is at least `ring` whole cells away.
            if (best >= 0 && bestDistance <= ring * CELL) break;
        }
        return best >= 0 ? chars[best] : undefined;
    };
}

/** Two independent 32-bit hashes, length delimited; synchronous and Worker-safe. */
function fingerprint(chunks: Uint8Array[]): string {
    let a = 2166136261, b = 0x9e3779b9;
    for (const chunk of chunks) {
        for (const c of chunk) { a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x85ebca6b); }
        a = Math.imul(a ^ chunk.length, 16777619); b = Math.imul(b ^ chunk.length, 0xc2b2ae35);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
const understood = new Set(('q Q cm w J j M d ri i gs BT ET Tf Tm Td TD T* Tc Tw Tz TL Ts Tr Tj TJ \' " g G rg RG k K cs CS sc SC scn SCN m l c v y h re W W* S s f F f* B B* b b* n Do BI sh BMC BDC EMC MP DP BX EX d0 d1').split(' '));
/** Operators that register a page object (text, painted or clipping path, image or form, inline image, shading). */
const OBJECT_OPERATORS = new Set(['Tj', 'TJ', "'", '"', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'Do', 'BI', 'sh']);
const PATH_OPERATORS = new Set('m l c v y h re W W* S s f F f* B B* b b* n q Q cm w J j M d ri i gs g G rg RG k K cs CS sc SC scn SCN'.split(' '));
function harden(model: PageModel, meta: PageDetails): void {
    const deny = (o: PageObject, reason: string, all = true) => {
        o.editability = { move: false, delete: !all && o.editability.delete, recolor: false, opacity: false, reorder: false, replace: false, crop: false, reason };
    };
    // Everything below is linear in the number of objects. The first version rescanned every object for each
    // object and for each text block, which froze Edit mode on drawings and maps (16,000 objects took 5 s,
    // 75,000 took minutes).
    const bySource = new Map<Source, ObjectDetail[]>();
    for (const d of meta.objects.values()) {
        const list = bySource.get(d.source);
        if (list) list.push(d); else bySource.set(d.source, [d]);
    }
    for (const src of meta.sources) {
        const own = bySource.get(src) ?? [], ops = src.parsed.operations;
        const peers = new Map<string, number>();
        for (const d of own) peers.set(d.scope, (peers.get(d.scope) ?? 0) + 1);
        // In stream order, so the members of each text block are found without rescanning all objects.
        const ordered = [...own].sort((a, b) => a.object.ops.first - b.object.ops.first);
        let next = 0;
        const unknown = ops.find(o => !understood.has(o.operator));
        const unsupported = unknown ? `Unknown operator ${unknown.operator} in enclosing content` : src.parsed.warnings.length ? 'Malformed content cannot be safely edited' : undefined;
        let start = -1;
        for (let i = 0; i < ops.length; i++) {
            if (ops[i].operator === 'BT') start = i;
            if (ops[i].operator === 'ET' && start >= 0) {
                while (next < ordered.length && ordered[next].object.ops.first < start) next++;
                const block: ObjectDetail[] = [];
                for (let j = next; j < ordered.length && ordered[j].object.ops.first <= i; j++)
                    if (ordered[j].object.ops.last <= i) block.push(ordered[j]);
                const clips = block.some(d => d.object.kind === 'text' && d.object.renderMode >= 4);
                for (const d of block) {
                    d.textBlock = [start, i];
                    if (src.parts) d.object.ops.streams = src.parts.filter(p => p.end > ops[start].start && p.start < ops[i].end).map(p => p.index);
                    if (clips) deny(d.object, 'Text clipping takes effect at ET; edit the complete clipping block');
                }
                start = -1;
            }
        }
        for (const d of own) {
            const o = d.object;
            if (unsupported) deny(o, unsupported);
            if (start >= 0 && o.ops.first >= start) deny(o, 'Unterminated text object');
            if (o.kind === 'text' && !o.editable) deny(o, 'Unsupported font, Type3 glyph procedure or unmapped code');
            if (o.kind === 'inline-image' && ops[o.ops.first].inlineImage?.editable === false)
                deny(o, ops[o.ops.first].inlineImage?.reason ?? 'Inline image boundary is uncertain');
            const pattern = /Pattern/.test(d.before.fillSpace + d.before.strokeSpace) ||
                /\/[^ ]+\s+scn|\/[^ ]+\s+SCN/.test(d.before.fillCommand + ' ' + d.before.strokeCommand);
            if (pattern) deny(o, 'Pattern painting cannot be independently transformed or recolored', false);
            if (d.before.inText && o.kind !== 'text') deny(o, 'Painting inside a text object cannot be isolated safely');
            if ((peers.get(d.scope) ?? 0) < 2) { o.editability.reorder = false; o.editability.reason ??= 'No other object inside this graphics, clip, transparency or marked-content scope'; }
            if (o.kind === 'path') {
                let foreign = false;
                for (let k = o.ops.first; k <= o.ops.last && !foreign; k++) foreign = !PATH_OPERATORS.has(ops[k].operator);
                if (foreign) deny(o, 'Path is interleaved with other painting or unsupported state');
            }
            if (d.before.maskBBox) { o.editability.reorder = false; o.editability.reason ??= 'Soft-mask placement cannot be reconstructed for reordering'; }
            if (d.hasClip) { o.editability.reorder = false; o.editability.reason ??= 'Path establishes a clipping dependency'; }
            if (o.kind === 'text' && [1,2,5,6].includes(o.renderMode)) {
                const scale = Math.hypot(...d.before.ctm.slice(0,4));
                o.renderBBox = expand(o.renderBBox, Math.max(.5, d.before.lineWidth * scale * Math.max(1,d.before.miter)));
            }
            if (d.before.clip) o.renderBBox = union(o.renderBBox, d.before.clip);
        }
    }
}
