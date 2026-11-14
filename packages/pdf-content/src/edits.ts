import * as mupdf from 'mupdf';
import type { EditResult, InsertTextSpec, Matrix, PageModel, PageObject, Rect, RGB, TextRun } from './types.js';
import { concat, IDENTITY, invert, point, translate, transformRect } from './geometry.js';
import { contentRefs, flattenObjects, getPageDetails, interpretPage, streamBytes, type GraphicsState, type ObjectDetail, type PageDetails, type Source } from './interpreter.js';
import { encodeText, invalidateFontCache } from './fonts.js';
import { addFontSafe, addImageSafe, resourceFingerprint } from './resources.js';
import { parseContent, serializeContent, serializeValue } from './parser.js';
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);
function join(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
} return result; }
function number(n: number): string { if (!Number.isFinite(n))
    throw new Error('Expected a finite number'); return n.toFixed(10).replace(/\.?0+$/, '') || '0'; }
function nums(ns: number[]): string { return ns.map(number).join(' '); }
function pdfName(n: string): string { return serializeValue({ type: 'name', value: n }); }

/** Promote a verified raw inline image into a resource before changing its placement. */
function inlineSpec(d: ObjectDetail): { width: number; height: number; bits: number; space: string; data: Uint8Array } | string {
    if (d.object.kind !== 'inline-image') return 'Expected an inline image';
    const inline = d.source.parsed.operations[d.object.ops.first].inlineImage;
    if (!inline?.editable || inline.boundary !== 'exact') return 'Inline image boundary is uncertain';
    const dict = inline.dict;
    const supportedKeys = new Set(['Width','Height','ColorSpace','BitsPerComponent','Length']);
    if (Object.keys(dict).some(key => !supportedKeys.has(key)))
        return 'Inline image has properties that cannot be preserved during conversion';
    const nameOf = (value: unknown): string | undefined => value && typeof value === 'object' && 'type' in value && value.type === 'name' && 'value' in value ? String(value.value) : undefined;
    const color = nameOf(dict.ColorSpace);
    const space = color === 'RGB' ? 'DeviceRGB' : color === 'G' ? 'DeviceGray' : color === 'CMYK' ? 'DeviceCMYK' : color;
    const width = Number(dict.Width), height = Number(dict.Height), bits = Number(dict.BitsPerComponent ?? 8);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(bits) || width <= 0 || height <= 0 || ![1,2,4,8,16].includes(bits) || !['DeviceRGB','DeviceGray','DeviceCMYK'].includes(space ?? '') || dict.Filter || dict.DecodeParms || dict.ImageMask || dict.Decode)
        return 'Inline image encoding cannot be converted without changing its appearance';
    const components = space === 'DeviceRGB' ? 3 : space === 'DeviceCMYK' ? 4 : 1;
    if (inline.data.length !== Math.ceil(width * components * bits / 8) * height)
        return 'Inline image byte length does not match its dimensions';
    return { width, height, bits, space: space!, data: inline.data };
}
export function inlineImageConversionReason(model: PageModel, id: string): string | null {
    const d = getPageDetails(model).objects.get(id);
    if (!d) throw new StaleObjectError(id);
    const spec = inlineSpec(d);
    return typeof spec === 'string' ? spec : null;
}

function simpleFormSpec(doc: mupdf.PDFDocument, d: ObjectDetail): { body: Uint8Array; matrix: Matrix; bbox: Rect } | string {
    if (d.object.kind !== 'form') return 'Expected a Form XObject';
    const ref = doc.newIndirect(d.object.objNum);
    try {
    if (ref.get('Subtype').asName() !== 'Form') return 'Selected object is not a Form XObject';
    if (!ref.get('Group').isNull()) return 'Transparency groups cannot be expanded safely';
    const res = ref.get('Resources');
    let hasResources = false;
    if (!res.isNull()) {
        if (!res.isDictionary()) return 'Form resources are malformed';
        res.forEach(() => { hasResources = true; });
    }
    if (hasResources) return 'Form resources need scoped name remapping before expansion';
    const box = ref.get('BBox');
    if (!box.isArray() || box.length !== 4) return 'Form bounding box is unavailable';
    const bbox = [0,1,2,3].map(i => box.get(i).asNumber()) as Rect;
    try { validRect(bbox); } catch { return 'Form bounding box is invalid'; }
    const m = ref.get('Matrix');
    const matrix = m.isNull() ? [1,0,0,1,0,0] as Matrix : m.isArray() && m.length === 6 ? [0,1,2,3,4,5].map(i => m.get(i).asNumber()) as Matrix : null;
    if (!matrix) return 'Form matrix is invalid';
    try { validMatrix(matrix); } catch { return 'Form matrix is invalid'; }
    const stream = ref.readStream();
    let body: Uint8Array;
    try { body = Uint8Array.from(stream.asUint8Array()); } finally { stream.destroy(); }
    const parsed = parseContent(body);
    if (parsed.warnings.length) return 'Malformed form content cannot be expanded safely';
    const safe = new Set('q Q cm m l c v y h re W W* S s f F f* B B* b b* n w J j M d ri i g G rg RG k K'.split(' '));
    if (parsed.operations.some(op => !safe.has(op.operator))) return 'Form contains text, images, resources or unsupported operators';
    let depth = 0;
    for (const op of parsed.operations) {
        if (op.operator === 'q') depth++;
        if (op.operator === 'Q' && --depth < 0) return 'Form graphics state is unbalanced';
    }
    if (depth) return 'Form graphics state is unbalanced';
    let pending = false;
    const geometry = new Set('m l c v y h re W W*'.split(' '));
    const clears = new Set('S s f F f* B B* b b* n'.split(' '));
    for (const op of parsed.operations) {
        if (geometry.has(op.operator)) pending = true;
        if (clears.has(op.operator)) pending = false;
    }
    if (pending) return 'Form ends with an unfinished path';
    return { body, matrix, bbox };
    } finally { ref.destroy(); }
}
export function simpleFormExpansionReason(doc: mupdf.PDFDocument, model: PageModel, id: string): string | null {
    const d = getPageDetails(model).objects.get(id);
    if (!d) throw new StaleObjectError(id);
    if (pendingPathAtForm(d)) return 'A page path is active at this form invocation';
    const spec = simpleFormSpec(doc, d);
    return typeof spec === 'string' ? spec : null;
}
function pendingPathAtForm(d: ObjectDetail): boolean {
    let pending = false;
    const geometry = new Set('m l c v y h re W W*'.split(' '));
    const clears = new Set('S s f F f* B B* b b* n'.split(' '));
    for (const op of d.source.parsed.operations.slice(0,d.object.ops.first)) {
        if (geometry.has(op.operator)) pending = true;
        if (clears.has(op.operator)) pending = false;
    }
    return pending;
}
/** Expand only simple resource-free Form XObjects into their selected page occurrence. */
export function expandSimpleForm(doc: mupdf.PDFDocument, pageIndex: number, id: string): EditResult {
    const edit = new EditSession(doc, pageIndex, [id], 'move'), d = edit.targets[0];
    if (pendingPathAtForm(d)) throw new UnsupportedEditError('replace', id, 'A page path is active at this form invocation');
    const spec = simpleFormSpec(doc, d);
    if (typeof spec === 'string') throw new UnsupportedEditError('replace', id, spec);
    edit.replace(d, join(bytes(`\nq\n${nums(spec.matrix)} cm\n${nums([spec.bbox[0],spec.bbox[1],spec.bbox[2]-spec.bbox[0],spec.bbox[3]-spec.bbox[1]])} re W n\n`),spec.body,bytes('\nn\nQ\n')));
    return edit.finish();
}
export function convertInlineImage(doc: mupdf.PDFDocument, pageIndex: number, id: string): EditResult {
    const edit = new EditSession(doc, pageIndex, [id], 'move'), d = edit.targets[0];
    const spec = inlineSpec(d);
    if (typeof spec === 'string') throw new UnsupportedEditError('replace', id, spec);
    const ref = doc.addRawStream(spec.data, { Type:'XObject', Subtype:'Image', Width:spec.width, Height:spec.height, ColorSpace:spec.space, BitsPerComponent:spec.bits });
    const name = addResource(doc, edit.resource(d.source), 'XObject', 'GarnetInline', ref);
    edit.replace(d, bytes(`\n${pdfName(name)} Do\n`));
    const result = edit.finish();
    const promoted = flattenObjects(result.model.objects).find(o => o.kind === 'image' && o.resName === name && o.ops.first === d.object.ops.first && o.formPath.join('/') === d.object.formPath.join('/'));
    if (!promoted) throw new ContentEditError('Converted inline image was not interpreted');
    result.newIds[id] = [promoted.id];
    return result;
}
function hex(b: Uint8Array): string { return serializeValue({ type: 'string', bytes: b }); }
function validMatrix(m: Matrix): void { if (m.length !== 6 || !m.every(Number.isFinite))
    throw new Error('Expected a finite affine matrix'); invert(m); }
function validRect(r: Rect): void { if (r.length !== 4 || !r.every(Number.isFinite) || r[2] <= r[0] || r[3] <= r[1])
    throw new Error('Expected a rectangle with positive dimensions'); }
function validRGB(rgb: RGB): void { if (rgb.length !== 3 || !rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
    throw new Error('RGB components must be between 0 and 1'); }
export class ContentEditError extends Error {
    constructor(message: string) { super(message); this.name = 'ContentEditError'; }
}
export class StaleObjectError extends ContentEditError {
    constructor(id: string) { super(`Unknown or stale object id: ${id}`); this.name = 'StaleObjectError'; }
}
export class UnsupportedEditError extends ContentEditError {
    constructor(readonly operation: string, readonly objectId: string, reason: string) { super(reason); this.name = 'UnsupportedEditError'; }
}
export class GlyphPositionError extends ContentEditError {
    constructor() { super('Glyphs outside the changed range moved by more than 0.01 pt; abandon the journal operation'); this.name = 'GlyphPositionError'; }
}
type EditOperation = Exclude<keyof PageObject['editability'], 'reason'>;
function cloneDict(doc: mupdf.PDFDocument, from: mupdf.PDFObject): mupdf.PDFObject { const to = doc.newDictionary(); if (!from.isNull())
    from.forEach((v, k) => to.put(k, v)); return to; }
function resources(doc: mupdf.PDFDocument, owner: mupdf.PDFObject, from: mupdf.PDFObject): mupdf.PDFObject {
    const r = cloneDict(doc, from);
    for (const key of ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'])
        if (!r.get(key).isNull())
            r.put(key, cloneDict(doc, r.get(key)));
    owner.put('Resources', r);
    return r;
}
function unique(res: mupdf.PDFObject, group: string, prefix: string): string { let n = 1; while (!res.get(group, `${prefix}${n}`).isNull())
    n++; return `${prefix}${n}`; }
function addResource(doc: mupdf.PDFDocument, res: mupdf.PDFObject, group: string, prefix: string, ref: mupdf.PDFObject): string {
    let d = res.get(group);
    if (d.isNull()) {
        d = doc.newDictionary();
        res.put(group, d);
    }
    const name = unique(res, group, prefix);
    d.put(name, ref);
    return name;
}
function original(detail: ObjectDetail): Uint8Array { const { source, object } = detail; const ops = source.parsed.operations; return source.parsed.bytes.slice(ops[object.ops.first].start, ops[object.ops.last].end); }
/** Restore both text and line matrices: a numeric TJ moves only the former. */
function textState(s: GraphicsState): string {
    if (!s.font)
        throw new ContentEditError('Text has no resolved font');
    const fontCommand = s.fontResName.startsWith('@') ? `${pdfName(s.fontResName.slice(1))} gs` : `${pdfName(s.fontResName)} ${number(s.size)} Tf`;
    const delta = concat(s.tm, invert(s.lm)), vertical = s.font.info.wmode;
    const distance = vertical ? delta[5] : delta[4], scale = s.size * (vertical ? 1 : s.hScale / 100);
    if (Math.abs(vertical ? delta[4] : delta[5]) > 1e-6)
        throw new ContentEditError('Cannot restore a nonparallel text matrix');
    if (Math.abs(distance) > 1e-8 && Math.abs(scale) < 1e-12)
        throw new ContentEditError('Cannot restore text at zero font scale');
    return `${fontCommand}\n${number(s.charSpacing)} Tc ${number(s.wordSpacing)} Tw ${number(s.hScale)} Tz ${number(s.leading)} TL ${number(s.rise)} Ts ${number(s.renderMode)} Tr\n${nums(s.lm)} Tm\n${Math.abs(distance) > 1e-8 ? `[${number(-distance / scale * 1000)}] TJ\n` : ''}`;
}
function textWrapper(d: ObjectDetail, body: Uint8Array, prefix = ''): Uint8Array {
    const o = d.object;
    if (o.kind !== 'text')
        throw new Error('Expected text');
    if (o.renderMode >= 4)
        throw new ContentEditError('Clipping text requires editing the complete clipping span');
    return join(bytes(`\nET\nq\n${prefix}BT\n${textState(d.before)}`), body, bytes(`\nET\nQ\nBT\n${textState(d.after)}`));
}
function deletion(d: ObjectDetail): Uint8Array {
    if (d.object.kind === 'text')
        return bytes(`\n${quotePrefix(d)}${nums(d.after.lm)} Tm\n${textMatrixAdjustment(d.after)}`);
    if (d.object.kind === 'path')
        return join(pathStateOps(d), bytes(clipSideEffect(d)));
    return bytes('\n');
}
function textMatrixAdjustment(s: GraphicsState): string { const v = s.font?.info.wmode, delta = concat(s.tm, invert(s.lm)), distance = v ? delta[5] : delta[4], scale = s.size * (v ? 1 : s.hScale / 100); if (!distance)
    return ''; if (!scale)
    throw new ContentEditError('Cannot compensate zero font scale'); return `[${number(-distance / scale * 1000)}] TJ\n`; }
function quotePrefix(d: ObjectDetail): string { const op = d.source.parsed.operations[d.object.ops.last]; return op.operator === '"' ? `${serializeValue(op.operands[0])} Tw ${serializeValue(op.operands[1])} Tc T*\n` : op.operator === "'" ? 'T*\n' : ''; }
class EditSession {
    readonly model: PageModel;
    readonly targets: ObjectDetail[];
    readonly changed = new Set<Source>();
    readonly relocations = new Map<ObjectDetail, ObjectDetail[]>();
    private refs = new Map<Source, mupdf.PDFObject>();
    private res = new Map<Source, mupdf.PDFObject>();
    private pageRes?: mupdf.PDFObject;
    constructor(readonly doc: mupdf.PDFDocument, readonly pageIndex: number, ids: string[], operation?: EditOperation) {
        this.model = interpretPage(doc, pageIndex);
        const map = getPageDetails(this.model).objects;
        if (new Set(ids).size !== ids.length)
            ids = [...new Set(ids)];
        this.targets = ids.map(id => { const d = map.get(id); if (!d)
            throw new StaleObjectError(id); return d; });
        // An occurrence's parent chain is authoritative, regardless of revision prefixes.
        this.targets = this.targets.filter(d => !this.targets.some(p => {
            for (let parent = d.source.parent; parent; parent = parent.source.parent)
                if (p.source === parent.source && p.object.ops.first === parent.op) return true;
            return false;
        }));
        for (const d of this.targets) {
            if (operation && !d.object.editability[operation])
                throw new UnsupportedEditError(operation, d.object.id, d.object.editability.reason ?? 'Operation is unsupported');
            if (d.object.kind === 'path') {
                const allowed = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN']);
                for (let i = d.object.ops.first; i <= d.object.ops.last; i++)
                    if (!allowed.has(d.source.parsed.operations[i]?.operator))
                        throw new UnsupportedEditError(operation ?? 'replace', d.object.id, 'Path has interleaved state changes');
            }
        }
    }
    writable(src: Source): mupdf.PDFObject {
        let ref = this.refs.get(src);
        if (ref)
            return ref;
        if (src.parent) {
            this.writable(src.parent.source);
            ref = this.doc.addStream(streamBytes(src.ref), cloneDict(this.doc, src.ref));
            const r = this.resource(src.parent.source), name = addResource(this.doc, r, 'XObject', 'GarnetForm', ref);
            src.parent.source.parsed.operations[src.parent.op].replacement = bytes(`\n${pdfName(name)} Do\n`);
            this.changed.add(src.parent.source);
        } else ref = src.ref;
        this.refs.set(src, ref);
        return ref;
    }
    resource(src: Source): mupdf.PDFObject {
        this.writable(src);
        if (!src.parent) {
            if (!this.pageRes) {
                const p = this.doc.findPage(this.pageIndex);
                this.pageRes = resources(this.doc, p, p.getInheritable('Resources'));
            }
            return this.pageRes;
        }
        let r = this.res.get(src);
        if (r)
            return r;
        r = resources(this.doc, this.writable(src), src.resources);
        this.res.set(src, r);
        return r;
    }
    replace(d: ObjectDetail, replacement: Uint8Array): void {
        this.writable(d.source);
        const ops = d.source.parsed.operations;
        ops[d.object.ops.first].replacement = replacement;
        for (let i = d.object.ops.first + 1; i <= d.object.ops.last; i++)
            ops[i].replacement = new Uint8Array();
        this.changed.add(d.source);
    }
    finish(): EditResult {
        for (const src of this.changed) {
            if (!src.parts) { this.writable(src).writeStream(serializeContent(src.parsed)); continue; }
            const refs = contentRefs(this.doc.findPage(this.pageIndex));
            const replaced = src.parsed.operations.filter(o => o.replacement !== undefined);
            for (const part of src.parts) {
                const patches = replaced.filter(o => o.end > part.start && o.start < part.end);
                const dependentSpan = this.targets.some(d => d.source === src && d.object.ops.streams.includes(part.index));
                if (!patches.length && !dependentSpan) continue;
                let cursor = part.start; const pieces: Uint8Array[] = [];
                for (const op of patches) {
                    pieces.push(src.parsed.bytes.slice(cursor, Math.max(cursor, op.start)));
                    if (op.start >= part.start) pieces.push(op.replacement!);
                    cursor = Math.min(part.end, op.end);
                }
                pieces.push(src.parsed.bytes.slice(cursor, part.end));
                refs[part.index] = this.doc.addStream(join(...pieces), cloneDict(this.doc, part.ref));
            }
            const array = this.doc.newArray(); for (const ref of refs) array.push(ref);
            this.doc.findPage(this.pageIndex).put('Contents', array);
        }
        invalidateFontCache(this.doc);
        const model = interpretPage(this.doc, this.pageIndex), newIds: Record<string, string[]> = {};
        const previous = getPageDetails(this.model), current = getPageDetails(model);
        // Old object ids are mapped to the new ones through indexes, so the work stays in step with the number of
        // objects. The first version compared every old object with every new one, which made a single move take
        // 14 s on a page with 16,000 objects and minutes on a detailed drawing.
        const group = (details: PageDetails) => {
            const bySource = new Map<Source, ObjectDetail[]>();
            for (const d of details.objects.values()) {
                const list = bySource.get(d.source);
                if (list) list.push(d); else bySource.set(d.source, [d]);
            }
            return bySource;
        };
        const previousBySource = group(previous), currentBySource = group(current);
        // The form object that starts at an operator of a source (the first one, as a linear search would find).
        const previousForms = new Map<Source, Map<number, ObjectDetail>>();
        for (const [source, list] of previousBySource) {
            const forms = new Map<number, ObjectDetail>();
            for (const d of list) if (d.object.kind === 'form' && !forms.has(d.object.ops.first)) forms.set(d.object.ops.first, d);
            previousForms.set(source, forms);
        }
        // For every new object id: the first new source (in walk order) that this object, as a form, opens.
        const currentAt = new Map<Source, Map<number, ObjectDetail[]>>();
        for (const [source, list] of currentBySource) {
            const at = new Map<number, ObjectDetail[]>();
            for (const d of list) { const same = at.get(d.object.ops.first); if (same) same.push(d); else at.set(d.object.ops.first, [d]); }
            currentAt.set(source, at);
        }
        const sourceOrder = new Map<Source, number>(), childSource = new Map<string, Source>();
        current.sources.forEach((source, order) => {
            sourceOrder.set(source, order);
            if (!source.parent) return;
            for (const d of currentAt.get(source.parent.source)?.get(source.parent.op) ?? [])
                if (!childSource.has(d.object.id)) childSource.set(d.object.id, source);
        });
        const rootSource = current.sources.find(s => !s.parent);
        for (const src of previous.sources) {
            let next: Source | undefined;
            if (!src.parent) next = rootSource;
            else {
                const parent = previousForms.get(src.parent.source)?.get(src.parent.op);
                for (const id of parent ? newIds[parent.object.id] ?? [] : []) {
                    const child = childSource.get(id);
                    if (child && (!next || sourceOrder.get(child)! < sourceOrder.get(next)!)) next = child;
                }
            }
            const offsets: { start: number; end: number }[] = [];
            let delta = 0;
            // Stream boundaries inside an operator, counted with a moving pointer (parts and operators both ascend).
            const boundaries = [...(src.parts ?? [])].map(p => p.end).sort((x, y) => x - y);
            let boundary = 0;
            for (const op of src.parsed.operations) {
                const start = op.start + delta;
                while (boundary < boundaries.length && boundaries[boundary] < op.start) boundary++;
                let separators = 0;
                for (let j = boundary; j < boundaries.length && boundaries[j] < op.end; j++) separators++;
                const length = op.replacement === undefined ? op.end - op.start : op.replacement.length + separators;
                offsets.push({ start, end: start + length });
                delta += length - (op.end - op.start);
            }
            // New objects of the matching source by where they start, to find those inside a byte range directly.
            const ranged = (next ? currentBySource.get(next) ?? [] : []).map((d, order) => {
                const ops = d.source.parsed.operations;
                return { d, order, start: ops[d.object.ops.first].start, end: ops[d.object.ops.last].end };
            }).sort((x, y) => x.start - y.start || x.order - y.order);
            /** New objects that lie inside [from, to], in their original order. */
            const within = (from: number, to: number) => {
                let low = 0, high = ranged.length;
                while (low < high) { const mid = (low + high) >> 1; if (ranged[mid].start < from) low = mid + 1; else high = mid; }
                const found: typeof ranged = [];
                for (let j = low; j < ranged.length && ranged[j].start <= to; j++) if (ranged[j].end <= to) found.push(ranged[j]);
                return found.sort((x, y) => x.order - y.order).map(r => r.d);
            };
            for (const old of previousBySource.get(src) ?? []) {
                const first = offsets[old.object.ops.first], last = offsets[old.object.ops.last];
                newIds[old.object.id] = within(first.start, last.end).filter(d => {
                    if (d.object.kind !== old.object.kind) return false;
                    if (old.object.kind === 'text' && old.object.glyphs.length && d.object.kind === 'text' && !d.object.glyphs.length) return false;
                    return true;
                }).map(d => d.object.id);
            }
            // Moved drawings live in the anchor's replacement range, in the requested painting order.
            for (const [anchor, ordered] of this.relocations) {
                if (anchor.source !== src) continue;
                const first = offsets[anchor.object.ops.first], last = offsets[anchor.object.ops.last];
                const moved = within(first.start, last.end).filter(d => d.object.kind !== 'text' || d.object.glyphs.length > 0).sort((a,b) => a.object.z - b.object.z);
                if (moved.length !== ordered.length) throw new ContentEditError('Cannot map reordered occurrences; abandon the journal operation');
                ordered.forEach((d,i) => { newIds[d.object.id] = [moved[i].object.id]; });
            }
        }
        return { model, newIds };
    }
}
function pathStateOps(d: ObjectDetail): Uint8Array {
    const out: Uint8Array[] = [bytes('\n')], skip = new Set(d.pathOps ?? []);
    for (let i = d.object.ops.first; i < d.object.ops.last; i++) {
        const o = d.source.parsed.operations[i];
        if (!skip.has(i) && o.operator !== 'W' && o.operator !== 'W*')
            out.push(d.source.parsed.bytes.slice(o.start, o.end), bytes('\n'));
    }
    return join(...out);
}
function clipSideEffect(d: ObjectDetail): string {
    if (!d.hasClip)
        return '';
    const even = d.source.parsed.operations.slice(d.object.ops.first, d.object.ops.last).some(o => o.operator === 'W*');
    return `${localPath(d)}${even ? 'W*' : 'W'} n\n`;
}
function localPath(d: ObjectDetail): string {
    const inv = invert(d.before.ctm), rects = new Set(d.pathRects ?? []);
    const ops = parseContent(bytes(d.pathCommands ?? '')).operations, out: string[] = [];
    const local = (o: typeof ops[number]) => {
        const values = o.operands as number[], coordinates: number[] = [];
        for (let i = 0; i < values.length; i += 2)
            coordinates.push(...point([values[i], values[i + 1]], inv));
        return coordinates;
    };
    for (let i = 0; i < ops.length; i++) {
        // A rectangle that the page wrote with `re` goes back as `re` when it is still axis-aligned in its own
        // space: the spelled-out form is the same shape, but viewers treat a zero-height `re` as a hairline.
        if (rects.has(ops[i].start) && i + 4 < ops.length && ops[i].operator === 'm' && ops[i + 1].operator === 'l' && ops[i + 2].operator === 'l' && ops[i + 3].operator === 'l' && ops[i + 4].operator === 'h') {
            const [x0, y0] = local(ops[i]), [x1, y1] = local(ops[i + 1]), [x2, y2] = local(ops[i + 2]), [x3, y3] = local(ops[i + 3]);
            const tolerance = 1e-6 * Math.max(1, Math.abs(x0), Math.abs(y0), Math.abs(x2), Math.abs(y2));
            if (Math.abs(y1 - y0) <= tolerance && Math.abs(x2 - x1) <= tolerance && Math.abs(y3 - y2) <= tolerance && Math.abs(x3 - x0) <= tolerance) {
                const snap = (v: number) => (Math.abs(v) <= tolerance ? 0 : v);
                out.push(`${nums([x0, y0, snap(x1 - x0), snap(y3 - y0)])} re\n`);
                i += 4;
                continue;
            }
        }
        out.push(`${nums(local(ops[i]))} ${ops[i].operator}\n`);
    }
    return out.join('');
}
function wrapGraphics(d: ObjectDetail, prefix: string): Uint8Array {
    if (d.object.kind === 'path') {
        const paint = d.source.parsed.operations[d.object.ops.last].operator;
        return join(pathStateOps(d), bytes(`q\n${prefix}${localPath(d)}${paint}\nQ\n${clipSideEffect(d)}`));
    }
    return join(bytes(`\nq\n${prefix}`), original(d), bytes('\nQ\n'));
}
/** Apply m in page default user space, after each selected object's CTM. */
export function transformObjects(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], m: Matrix, options: {allowShapedText?: boolean} = {}): EditResult {
    validMatrix(m);
    const edit = new EditSession(doc, pageIndex, ids, options.allowShapedText ? undefined : 'move');
    if(options.allowShapedText)validateTextTargets(edit,'move',options);
    const handled=new Set<ObjectDetail>();
    if(options.allowShapedText)for(const d of edit.targets){
        if(handled.has(d)||d.object.kind!=='text'||!d.object.actualTextSpan||!d.object.markedContent?.some(t=>t.startsWith('GarnetTextBox_')))continue;
        const span=d.object.actualTextSpan, peers=[...getPageDetails(edit.model).objects.values()].filter(o=>o.object.kind==='text'&&o.object.actualTextSpan===span&&o.object.glyphs.length);
        if(!peers.every(o=>edit.targets.includes(o)))throw new UnsupportedEditError('move',d.object.id,'Move the complete logical text span');
        const start=Number(span.match(/\/marked(\d+)$/)?.[1]),ops=d.source.parsed.operations;
        let end=start,depth=1;
        while(depth&&++end<ops.length){if(['BMC','BDC'].includes(ops[end].operator))depth++;if(ops[end].operator==='EMC')depth--;}
        if(depth||ops[start]?.operator!=='BDC'||ops[start+1]?.operator!=='BT'||ops[end-1]?.operator!=='ET')throw new UnsupportedEditError('move',d.object.id,'Cannot isolate the logical text span');
        const local=concat(concat(d.before.ctm,m),invert(d.before.ctm));
        ops[start].replacement=join(bytes(`q\n${nums(local)} cm\n`),d.source.parsed.bytes.slice(ops[start].start,ops[start].end));
        ops[end].replacement=join(d.source.parsed.bytes.slice(ops[end].start,ops[end].end),bytes('\nQ\n'));
        edit.changed.add(d.source);peers.forEach(o=>handled.add(o));
    }
    const replacements = edit.targets.filter(d=>!handled.has(d)).map(d => { const local = concat(concat(d.before.ctm, m), invert(d.before.ctm)), prefix = `${nums(local)} cm\n`; return [d, d.object.kind === 'text' ? textWrapper(d, original(d), prefix) : wrapGraphics(d, prefix)] as const; });
    for (const [d, b] of replacements)
        edit.replace(d, b);
    return edit.finish();
}
function validateTextTargets(edit:EditSession,operation:'move'|'delete',options:{allowType3Text?:boolean;allowShapedText?:boolean}):void{
    const all=[...getPageDetails(edit.model).objects.values()],selected=new Set(edit.targets),spans=new Map<string,boolean>();
    const complete=(span:string)=>{if(!spans.has(span))spans.set(span,all.filter(o=>o.object.kind==='text'&&o.object.actualTextSpan===span&&o.object.glyphs.length>0).every(o=>selected.has(o)));return spans.get(span)!;};
    for (const d of edit.targets) {
        if(options.allowShapedText&&d.object.kind==='text'&&d.object.actualTextSpan&&d.object.markedContent?.some(t=>t.startsWith('GarnetTextBox_'))&&!complete(d.object.actualTextSpan))throw new UnsupportedEditError(operation,d.object.id,'Edit the complete logical text span');
        if (d.object.editability[operation]) continue;
        // Removing a complete, ordinary Type3 text-show does not require interpreting
        // CharProcs. Keep the default refusal and all clip/unknown-source guards.
        const safeOps = new Set(('q Q cm w J j M d ri i gs BT ET Tf Tm Td TD T* Tc Tw Tz TL Ts Tr Tj TJ \' " g G rg RG k K cs CS sc SC scn SCN m l c v y h re W W* S s f F f* B B* b b* n Do BI sh BMC BDC EMC MP DP BX EX').split(' '));
        const shaped = options.allowShapedText && d.object.kind === 'text' && d.object.actualTextSpan && d.object.markedContent?.some(t=>t.startsWith('GarnetTextBox_')) && d.before.font?.info.encoding === 'Identity-H' && d.before.font.info.embedded &&
            complete(d.object.actualTextSpan);
        const safe = d.object.kind === 'text' && (options.allowType3Text && d.before.font?.info.subtype === 'Type3' || shaped) &&
            (d.object.renderMode === 0 || d.object.renderMode === 3) && (!d.object.clipped || shaped) &&
            !d.before.maskBBox && d.object.editability.reason === 'Unsupported font, Type3 glyph procedure or unmapped code' &&
            !d.source.parsed.warnings.length && d.source.parsed.operations.every(o => safeOps.has(o.operator)) &&
            d.textBlock && !d.source.parsed.operations.slice(d.textBlock[0],d.textBlock[1]+1).some(o => o.operator === 'Tr' && Number(o.operands[0]) >= 4);
        if (!safe) throw new UnsupportedEditError(operation,d.object.id,d.object.editability.reason ?? 'Unsafe Type3 text deletion');
    }
}
/** Remove painting; preserve text advancement and path clipping side effects. */
export function deleteObjects(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], options: { allowType3Text?: boolean; allowShapedText?: boolean } = {}): EditResult {
    const optIn = options.allowType3Text || options.allowShapedText;
    const edit = new EditSession(doc, pageIndex, ids, optIn ? undefined : 'delete');
    if (optIn)validateTextTargets(edit,'delete',options);
    const replacements = edit.targets.map(d => [d, deletion(d)] as const);
    for (const [d, b] of replacements)
        edit.replace(d, b);
    // A fully removed owned span must not leave an empty ActualText replacement behind.
    // Keep other marked-content scopes and partial spans exactly as they were.
    const all=[...getPageDetails(edit.model).objects.values()];
    for(const d of edit.targets){
        if(d.object.kind!=='text'||!d.object.actualTextSpan||!d.object.markedContent?.some(t=>t.startsWith('GarnetTextBox_')))continue;
        const span=d.object.actualTextSpan;
        if(!all.filter(o=>o.object.kind==='text'&&o.object.actualTextSpan===span).every(o=>edit.targets.includes(o)))continue;
        const marker=Number(span.match(/\/marked(\d+)$/)?.[1]);
        const op=d.source.parsed.operations[marker];
        if(op?.operator==='BDC'){op.replacement=bytes(`${serializeValue(op.operands[0])} BMC\n`);edit.changed.add(d.source);}
    }
    const result = edit.finish();
    for (const d of edit.targets)
        result.newIds[d.object.id] = [];
    return result;
}
/** Capture only the vector clip state that can be faithfully replayed for paragraph reflow.
 * Transparency groups, masks, non-normal blends and clipping text remain fail-closed. */
export function getTextReflowState(model: PageModel, ids: string[]): {clip: string; renderMode: 0 | 3} {
    const details=getPageDetails(model), selected=ids.map(id=>details.objects.get(id));
    let clip: string|undefined, mode: number|undefined;
    for(const d of selected){
        if(!d || d.object.kind!=='text')throw new ContentEditError('Expected text for paragraph reflow');
        if(d.object.renderMode!==0&&d.object.renderMode!==3)throw new ContentEditError('Stroked and clipping text cannot be reflowed');
        if(d.before.maskBBox||d.before.fillAlpha!==1||d.before.strokeAlpha!==1)throw new ContentEditError('Transparent or masked text cannot be reflowed');
        for(let source:Source|undefined=d.source;source;source=source.parent?.source){
            if(source.parent&&!source.ref.get('Group').isNull())throw new ContentEditError('Text inside a transparency group cannot be reflowed');
            for(const name of d.before.extStates){
                const bm=source.resources.get('ExtGState',name,'BM');
                if(!bm.isNull()&&!(bm.isName()&&['Normal','Compatible'].includes(bm.asName())))throw new ContentEditError('Text with a blending mode cannot be reflowed');
            }
        }
        const current=d.before.clips.join('');
        if(clip!==undefined&&clip!==current || mode!==undefined&&mode!==d.object.renderMode)throw new ContentEditError('Text spans have different clipping or rendering states');
        clip=current;mode=d.object.renderMode;
    }
    return {clip:clip??'',renderMode:(mode??0) as 0|3};
}
function recolor(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], rgb: RGB, stroke: boolean): EditResult {
    validRGB(rgb);
    const edit = new EditSession(doc, pageIndex, ids, 'recolor'), prefix = `${nums(rgb)} ${stroke ? 'RG' : 'rg'}\n`;
    const replacements = edit.targets.map(d => [d, d.object.kind === 'text' ? textWrapper(d, original(d), prefix) : wrapGraphics(d, prefix)] as const);
    for (const [d, b] of replacements)
        edit.replace(d, b);
    return edit.finish();
}
export function setFillColor(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], rgb: RGB): EditResult { return recolor(doc, pageIndex, ids, rgb, false); }
export function setStrokeColor(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], rgb: RGB): EditResult { return recolor(doc, pageIndex, ids, rgb, true); }
/** Scope a new line width to painted paths without changing sibling drawing state. */
export function setStrokeWidth(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], width: number): EditResult {
    if (!Number.isFinite(width) || width < 0) throw new ContentEditError('Stroke width must be a nonnegative finite number');
    const edit = new EditSession(doc, pageIndex, ids, 'recolor');
    for (const d of edit.targets) {
        if (d.object.kind !== 'path' || !d.object.paint.stroke)
            throw new UnsupportedEditError('recolor', d.object.id, 'Stroke width applies only to a stroked vector path');
        edit.replace(d, wrapGraphics(d, `${number(width)} w\n`));
    }
    return edit.finish();
}
/** Create an ExtGState resource scoped to the targeted page or form. */
export function setOpacity(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], alpha: number): EditResult {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
        throw new Error('Opacity must be between 0 and 1');
    const edit = new EditSession(doc, pageIndex, ids, 'opacity');
    for (const d of edit.targets) {
        const r = edit.resource(d.source), ref = doc.addObject({ Type: 'ExtGState', ca: alpha, CA: alpha }), name = addResource(doc, r, 'ExtGState', 'GarnetAlpha', ref), prefix = `${pdfName(name)} gs\n`;
        edit.replace(d, d.object.kind === 'text' ? textWrapper(d, original(d), prefix) : wrapGraphics(d, prefix));
    }
    return edit.finish();
}
/** Crop in page default user space. The underlying image bytes are retained. */
export function cropImage(doc: mupdf.PDFDocument, pageIndex: number, id: string, clip: Rect): EditResult {
    validRect(clip);
    const edit = new EditSession(doc, pageIndex, [id], 'crop'), d = edit.targets[0];
    if (d.object.kind !== 'image' && d.object.kind !== 'inline-image')
        throw new ContentEditError('Expected an image');
    const inv = invert(d.before.ctm), ps = [[clip[0], clip[1]], [clip[2], clip[1]], [clip[2], clip[3]], [clip[0], clip[3]]].map(p => point(p as [
        number,
        number
    ], inv));
    const prefix = ps.map((p, i) => `${nums(p)} ${i ? 'l' : 'm'}`).join('\n') + '\nh W n\n';
    edit.replace(d, wrapGraphics(d, prefix));
    return edit.finish();
}
/** Replace only this drawing by default, or all painted uses of its image object. */
export function replaceImage(doc: mupdf.PDFDocument, pageIndex: number, id: string, image: Uint8Array, fit: 'stretch' | 'contain' | 'cover', allInstances = false): EditResult {
    if (!['stretch', 'contain', 'cover'].includes(fit))
        throw new Error('Unknown image fit');
    const initial = new EditSession(doc, pageIndex, [id], 'replace'), target = initial.targets[0];
    if (target.object.kind !== 'image')
        throw new ContentEditError('Expected an image XObject');
    const imageObjNum = target.object.objNum;
    const img = new mupdf.Image(image);
    try {
        // Resolve all requested occurrences before changing any stream, then isolate shared forms.
        const sessions = [initial];
        if (allInstances) {
            sessions.length = 0;
            for (let page = 0; page < doc.countPages(); page++) {
                const model = page === pageIndex ? initial.model : interpretPage(doc, page);
                const ids = flattenObjects(model.objects).filter(o => o.kind === 'image' && o.objNum === imageObjNum).map(o => o.id);
                if (ids.length)
                    sessions.push(new EditSession(doc, page, ids, 'replace'));
            }
        }
        const ref = addImageSafe(doc, img, resourceFingerprint(image));
        let result: EditResult | undefined;
        for (const edit of sessions) {
            for (const d of edit.targets) {
                const r = edit.resource(d.source), name = addResource(doc, r, 'XObject', 'GarnetImage', ref);
                const w = Math.hypot(d.before.ctm[0], d.before.ctm[1]), h = Math.hypot(d.before.ctm[2], d.before.ctm[3]);
                if (!w || !h)
                    throw new ContentEditError('Cannot fit a degenerate image');
                let sx = 1, sy = 1;
                if (fit !== 'stretch') {
                    const ratio = (img.getWidth() / img.getHeight()) / (w / h);
                    if ((fit === 'contain') === (ratio > 1))
                        sy = 1 / ratio;
                    else
                        sx = ratio;
                }
                edit.replace(d, bytes(`\nq\n${fit === 'cover' ? '0 0 1 1 re W n\n' : ''}${nums([sx, 0, 0, sy, (1 - sx) / 2, (1 - sy) / 2])} cm\n${pdfName(name)} Do\nQ\n`));
            }
            const next = edit.finish();
            if (edit.pageIndex === pageIndex)
                result = next;
        }
        if (!result)
            throw new ContentEditError('No image instance was replaced');
        // A later page may share a resource; return the final, current interpretation.
        if (allInstances)
            result.model = interpretPage(doc, pageIndex);
        return result;
    }
    finally {
        img.destroy();
    }
}
function insertionMapping(before: PageModel, after: PageModel): Record<string, string[]> {
    const fresh = flattenObjects(after.objects);
    return Object.fromEntries(flattenObjects(before.objects).map((o,i) => [o.id, fresh[i] ? [fresh[i].id] : []]));
}
function pageResources(doc: mupdf.PDFDocument, pageIndex: number): mupdf.PDFObject { const p = doc.findPage(pageIndex); return resources(doc, p, p.getInheritable('Resources')); }
/** Isolate the old state in new wrapper streams; old content bytes and references are untouched. */
function append(doc: mupdf.PDFDocument, pageIndex: number, body: string): void {
    const p = doc.findPage(pageIndex), refs = contentRefs(p);
    let depth = 0, min = 0, inText = false;
    for (const op of parseContent(join(...refs.flatMap(r => [streamBytes(r), bytes('\n')]))).operations) {
            if (op.operator === 'q')
                depth++;
            if (op.operator === 'Q')
                depth--;
            min = Math.min(min, depth);
            if (op.operator === 'BT')
                inText = true;
            if (op.operator === 'ET')
                inText = false;
        }
    const guards = 1 - min, arr = doc.newArray();
    arr.push(doc.addStream('q\n'.repeat(guards), {}));
    for (const r of refs)
        arr.push(r);
    arr.push(doc.addStream(`${inText ? 'ET\n' : ''}${'Q\n'.repeat(guards + depth)}${body}`, {}));
    p.put('Contents', arr);
}
export function insertImage(doc: mupdf.PDFDocument, pageIndex: number, image: Uint8Array, rect: Rect): {
    model: PageModel;
    id: string;
    newIds: Record<string, string[]>;
} {
    validRect(rect);
    const before = interpretPage(doc, pageIndex);
    const img = new mupdf.Image(image);
    try {
        const ref = addImageSafe(doc, img, resourceFingerprint(image)), name = addResource(doc, pageResources(doc, pageIndex), 'XObject', 'GarnetImage', ref);
        append(doc, pageIndex, `q ${nums([rect[2] - rect[0], 0, 0, rect[3] - rect[1], rect[0], rect[1]])} cm ${pdfName(name)} Do Q\n`);
        const model = interpretPage(doc, pageIndex), obj = flattenObjects(model.objects).findLast(o => o.kind === 'image' && o.resName === name);
        if (!obj)
            throw new ContentEditError('Inserted image was not interpreted');
        return { model, id: obj.id, newIds: insertionMapping(before, model) };
    }
    finally {
        img.destroy();
    }
}
function actualText(s: string): string { const data = new Uint8Array(2 + s.length * 2); data[0] = 254; data[1] = 255; for (let i = 0; i < s.length; i++) {
    data[2 + i * 2] = s.charCodeAt(i) >> 8;
    data[3 + i * 2] = s.charCodeAt(i) & 255;
} return `/Span <</ActualText ${hex(data)}>> BDC\n`; }
function rtlText(text: string): boolean { for (const ch of text) {
    if (/[\u0590-\u08ff\ufb50-\ufeff]/u.test(ch))
        return true;
    if (/\p{Letter}/u.test(ch))
        return false;
} return false; }
/** Existing fonts retain their encoding. New fonts are embedded as Identity-H and written as two-byte GIDs. */
export function insertText(doc: mupdf.PDFDocument, pageIndex: number, spec: InsertTextSpec | InsertTextSpec[]): {
    model: PageModel;
    id: string;
    newIds: Record<string, string[]>;
} {
    if(!Array.isArray(spec))return writeText(doc,pageIndex,spec);
    if(!spec.length)throw new ContentEditError('Expected at least one text run');
    const model=interpretPage(doc,pageIndex),batch={model,fonts:new Map<Uint8Array,mupdf.PDFObject>(),resources:pageResources(doc,pageIndex),bodies:[] as string[]};
    const names=spec.map(s=>writeText(doc,pageIndex,s,batch).id);
    append(doc,pageIndex,batch.bodies.join(''));
    invalidateFontCache(doc);
    const out=interpretPage(doc,pageIndex),object=flattenObjects(out.objects).find(o=>o.kind==='text'&&names.includes(o.fontResName));
    if(!object)throw new ContentEditError('Inserted text was not interpreted');
    return {model:out,id:object.id,newIds:insertionMapping(model,out)};
}
function writeText(doc: mupdf.PDFDocument, pageIndex: number, spec: InsertTextSpec, batch?: {model:PageModel;fonts:Map<Uint8Array,mupdf.PDFObject>;resources:mupdf.PDFObject;bodies:string[]}): {
    model: PageModel;
    id: string;
    newIds: Record<string, string[]>;
} {
    validRGB(spec.color);
    if (!(spec.size > 0 && Number.isFinite(spec.size)))
        throw new Error('Text size must be positive');
    if (spec.renderMode !== undefined && spec.renderMode !== 0 && spec.renderMode !== 3)
        throw new ContentEditError('Only filled or invisible inserted text is supported');
    if(spec.clip){
        const parsed=parseContent(bytes(spec.clip)),allowed=new Set(['m','l','c','h','re','W','W*','n']);
        if(parsed.warnings.length||parsed.operations.some(o=>!allowed.has(o.operator)||o.operands.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw new ContentEditError('Invalid vector clipping state');
    }
    if (!spec.origin.every(Number.isFinite))
        throw new Error('Invalid text origin');
    const tm = concat(spec.matrix ?? IDENTITY, translate(...spec.origin));
    validMatrix(tm);
    if (spec.glyphs?.some(g => !Number.isInteger(g.gid) || g.gid < 0 || g.gid > 65535 || ![g.dx, g.dy, g.advance].every(Number.isFinite)))
        throw new Error('Invalid shaped glyph');
    if (spec.glyphs && !spec.actualText && !spec.text)
        throw new ContentEditError('Shaped glyphs require logical text or ActualText');
    const model = batch?.model ?? interpretPage(doc, pageIndex);
    let font: mupdf.Font | undefined, ref: mupdf.PDFObject, data: Uint8Array;
    if (spec.font.existingKey) {
        const info = model.fonts[spec.font.existingKey];
        if (!info)
            throw new ContentEditError('Unknown existing font key');
        if (spec.glyphs)
            throw new ContentEditError('Pre-shaped GIDs require a supplied font program');
        const encoded = encodeText(doc, info, spec.text ?? '');
        if (encoded.missing.length)
            throw new ContentEditError(`Missing glyphs: ${encoded.missing.join(', ')}`);
        data = encoded.bytes;
        if (info.objNum)
            ref = doc.newIndirect(info.objNum);
        else {
            const d = [...getPageDetails(model).objects.values()].find(d => d.before.font?.info.key === info.key);
            if (!d)
                throw new ContentEditError('Cannot locate direct font resource');
            ref = d.source.resources.get('Font', d.before.fontResName);
        }
    }
    else {
        const cached=spec.font.program&&spec.glyphs?batch?.fonts.get(spec.font.program):undefined;
        if(!cached)font = spec.font.program ? new mupdf.Font(spec.font.name ?? 'Garnet', spec.font.program) : new mupdf.Font(spec.font.name ?? 'Helvetica');
        const codes = spec.glyphs ? spec.glyphs.map(g => g.gid) : [...(spec.text ?? '')].map(c => font!.encodeCharacter(c));
        if (codes.some(c => c === 0)) {
            font?.destroy();
            throw new ContentEditError('New font is missing a requested glyph');
        }
        data = Uint8Array.from(codes.flatMap(c => [c >> 8, c & 255]));
        ref = cached ?? addFontSafe(doc, font!, spec.font.program ? resourceFingerprint(spec.font.program) : `name:${spec.font.name ?? 'Helvetica'}`);
        if(spec.font.program)batch?.fonts.set(spec.font.program,ref);
    }
    try {
        const name = addResource(doc, batch?.resources??pageResources(doc, pageIndex), 'Font', 'GarnetFont', ref);
        let body = `q\n${spec.clip??''}${nums(spec.color)} rg\n${spec.markTag ? `${pdfName(spec.markTag)} BMC\n` : ''}`;
        const logical = spec.actualText ?? (spec.glyphs || /[\u0590-\u08ff]/.test(spec.text ?? '') ? spec.text : undefined);
        if (logical !== undefined)
            body += actualText(logical);
        body += `BT\n${pdfName(name)} ${number(spec.size)} Tf\n${spec.renderMode ?? 0} Tr\n`;
        if (spec.glyphs) {
            let advance = 0;
            const positioned = spec.glyphs.map(g => { const pos = concat(translate(advance + g.dx, g.dy), tm); advance += g.advance; return { g, pos }; });
            // MuPDF applies bidi processing to ActualText. Paint RTL spans in logical order,
            // retaining the pre-shaped absolute positions and the original logical UTF-16 text.
            if (spec.direction === 'rtl' || (spec.direction === undefined && rtlText(logical ?? '')))
                positioned.reverse();
            for (const { g, pos } of positioned)
                body += `${nums(pos)} Tm <${g.gid.toString(16).padStart(4, '0')}> Tj\n`;
        }
        else
            body += `${nums(tm)} Tm ${hex(data)} Tj\n`;
        body += `ET\n${logical !== undefined ? 'EMC\n' : ''}${spec.markTag ? 'EMC\n' : ''}Q\n`;
        if(batch){batch.bodies.push(body);return {model,id:name,newIds:{}};}
        append(doc, pageIndex, body);
        invalidateFontCache(doc);
        const out = interpretPage(doc, pageIndex), obj = flattenObjects(out.objects).find(o => o.kind === 'text' && o.fontResName === name);
        if (!obj)
            throw new ContentEditError('Inserted text was not interpreted');
        return { model: out, id: obj.id, newIds: insertionMapping(model, out) };
    }
    finally {
        font?.destroy();
    }
}
/** Same-font replacement preserves original kerning in unchanged prefix/suffix and following text positions. */
export function replaceTextRun(doc: mupdf.PDFDocument, pageIndex: number, id: string, newText: string, options: { allowInvisible?: boolean } = {}): ({
    ok: true;
} & EditResult) | {
    ok: false;
    missing: string[];
    reason: 'missing-glyphs' | 'shaping-required' | 'actual-text-span' | 'uneditable' | 'invisible-text' | 'non-bijective-unicode';
} {
    const edit = new EditSession(doc, pageIndex, [id]), d = edit.targets[0], o = d.object;
    if (o.kind !== 'text')
        throw new ContentEditError('Expected a text run');
    if (o.renderMode === 3 && !options.allowInvisible)
        return { ok: false, missing: [], reason: 'invisible-text' };
    if (o.actualText !== undefined)
        return { ok: false, missing: [], reason: 'actual-text-span' };
    if (/[\p{Mark}\u0590-\u08ff\u0900-\u109f\u1780-\u17ff\ufb1d-\ufeff]/u.test(o.text + newText))
        return { ok: false, missing: [], reason: 'shaping-required' };
    const encoded = encodeText(doc, edit.model.fonts[o.fontKey], newText);
    if (encoded.missing.length)
        return { ok: false, missing: encoded.missing, reason: 'missing-glyphs' };
    if (!o.editable || !o.editability.replace)
        return { ok: false, missing: [], reason: 'uneditable' };
    const f = d.before.font!;
    if ([...o.glyphs.map(g => g.code), ...encoded.codes].some(code => !f.oneToOne(code)))
        return { ok: false, missing: [], reason: 'non-bijective-unicode' };
    if (newText === o.text) return { ok: true, ...edit.finish() };
    let prefix = 0, suffix = 0;
    while (prefix < encoded.codes.length && prefix < o.glyphs.length && encoded.codes[prefix] === o.glyphs[prefix].code)
        prefix++;
    while (suffix < encoded.codes.length - prefix && suffix < o.glyphs.length - prefix && encoded.codes[encoded.codes.length - 1 - suffix] === o.glyphs[o.glyphs.length - 1 - suffix].code)
        suffix++;
    const parts: string[] = [];
    let cursor: Matrix = [...o.textMatrix];
    for (let i = 0; i < encoded.codes.length; i++) {
        const old = i < prefix ? i : i >= encoded.codes.length - suffix ? o.glyphs.length - (encoded.codes.length - i) : -1;
        if (old >= 0) {
            const target = o.glyphs[old].textMatrix!, delta = concat(target, invert(cursor));
            const gap = f.info.wmode ? delta[5] : delta[4], scale = o.size * (f.info.wmode ? 1 : o.hScale / 100);
            if (gap && scale) parts.push(number(-gap / scale * 1000));
            cursor = [...target];
        }
        const code = encoded.codes[i]; parts.push(hex(f.codeBytes(code)));
        const word = code === 32 && f.codeBytes(code).length === 1 ? o.wordSpacing : 0;
        const advance = f.info.wmode ? f.vertical(code).advance / 1000 * o.size + o.charSpacing + word : (f.width(code) / 1000 * o.size + o.charSpacing + word) * o.hScale / 100;
        cursor = concat(translate(f.info.wmode ? 0 : advance, f.info.wmode ? advance : 0), cursor);
    }
    edit.replace(d, textWrapper(d, bytes(`${quotePrefix(d)}[${parts.join(' ')}] TJ\n`)));
    const result = edit.finish(), objects = flattenObjects(result.model.objects);
    const changed = objects.find(n => result.newIds[id].includes(n.id));
    const samePosition = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= .01;
    if (!changed || changed.kind !== 'text') throw new GlyphPositionError();
    for (let i = 0; i < prefix; i++) if (!samePosition(o.glyphs[i].origin, changed.glyphs[i]?.origin ?? [Infinity,Infinity])) throw new GlyphPositionError();
    for (let i = 1; i <= suffix; i++) if (!samePosition(o.glyphs.at(-i)!.origin, changed.glyphs.at(-i)?.origin ?? [Infinity,Infinity])) throw new GlyphPositionError();
    for (const untouched of flattenObjects(edit.model.objects)) {
        if (untouched.kind !== 'text' || untouched.id === id) continue;
        const current = objects.find(n => result.newIds[untouched.id]?.includes(n.id));
        if (!current || current.kind !== 'text' || current.glyphs.length !== untouched.glyphs.length || current.glyphs.some((g,i) => !samePosition(g.origin, untouched.glyphs[i].origin))) throw new GlyphPositionError();
    }
    return { ok: true, ...result };
}
function graphics(s: GraphicsState): string { return `${s.extStates.map(n => `${pdfName(n)} gs`).join('\n')}\n${s.fillCommand}\n${s.strokeCommand}\n${number(s.lineWidth)} w ${s.lineCap} J ${s.lineJoin} j ${number(s.miter)} M [${nums(s.dash)}] ${number(s.dashPhase)} d\n`; }
function standalone(d: ObjectDetail, at: GraphicsState): Uint8Array {
    const prefix = `\nq\n${nums(invert(at.ctm))} cm\n${d.before.clips.join('')}\n${nums(d.before.ctm)} cm\n${graphics(d.before)}`;
    const drawing = d.object.kind === 'path' ? bytes(`${localPath(d)}${d.source.parsed.operations[d.object.ops.last].operator}`) : original(d);
    return d.object.kind === 'text' ? join(bytes(`${prefix}BT\n${textState(d.before)}`), drawing, bytes('\nET Q\n')) : join(bytes(prefix), drawing, bytes('\nQ\n'));
}
/** Reorder within an identical clipping/resource context. Ambiguous cross-form/clip moves fail before mutation. */
export function reorderObjects(doc: mupdf.PDFDocument, pageIndex: number, ids: string[], direction: 'front' | 'forward' | 'backward' | 'back'): EditResult {
    if (!['front', 'forward', 'backward', 'back'].includes(direction))
        throw new Error('Unknown stacking direction');
    const edit = new EditSession(doc, pageIndex, ids, 'reorder');
    if (!edit.targets.length)
        return edit.finish();
    const selected = new Set(edit.targets.map(d => d.object.id)), first = edit.targets[0];
    if (edit.targets.some(d => d.source !== first.source || d.scope !== first.scope))
        throw new UnsupportedEditError('reorder', first.object.id, 'Reordering across graphics, clipping, transparency or marked-content scopes is unsupported');
    const siblings = [...getPageDetails(edit.model).objects.values()].filter(d => d.source === first.source && d.scope === first.scope).sort((a, b) => a.object.z - b.object.z);
    const picked = siblings.filter(d => selected.has(d.object.id)), others = siblings.filter(d => !selected.has(d.object.id));
    if (!others.length)
        return edit.finish();
    const low = picked[0].object.z, high = picked[picked.length - 1].object.z;
    const anchor = direction === 'front' ? others[others.length - 1] : direction === 'back' ? others[0] : direction === 'forward' ? others.find(d => d.object.z > high) : others.findLast(d => d.object.z < low);
    if (!anchor)
        return edit.finish();
    if (siblings.some(d => d.object.z >= Math.min(first.object.z, anchor.object.z) && d.object.z <= Math.max(first.object.z, anchor.object.z) && d.scope !== first.scope))
        throw new UnsupportedEditError('reorder', first.object.id, 'Reordering across graphics, clipping, transparency or marked-content scopes is unsupported');
    const after = direction === 'front' || direction === 'forward', at = after ? anchor.after : anchor.before;
    const blocks = join(...picked.map(d => standalone(d, at))), wrapped = at.inText ? join(bytes('\nET\n'), blocks, bytes(`\nBT\n${textState(at)}`)) : blocks;
    const raw = original(anchor), insert = after ? join(raw, wrapped) : join(wrapped, raw), deletes = picked.map(d => [d, deletion(d)] as const);
    for (const [d, b] of deletes)
        edit.replace(d, b);
    edit.replace(anchor, insert);
    edit.relocations.set(anchor, after ? [anchor, ...picked] : [...picked, anchor]);
    return edit.finish();
}
