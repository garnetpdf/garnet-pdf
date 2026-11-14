/** PDF row-vector affine matrix. Coordinates throughout this package are points. */
export type Matrix = [
    number,
    number,
    number,
    number,
    number,
    number
];
export type Rect = [
    number,
    number,
    number,
    number
];
export type RGB = [
    number,
    number,
    number
];
export type Point = [
    number,
    number
];
export type PDFValue = number | boolean | null | PDFName | PDFString | PDFValue[] | PDFDict;
export interface PDFName {
    type: 'name';
    value: string;
}
export interface PDFString {
    type: 'string';
    bytes: Uint8Array;
}
export interface PDFDict {
    type: 'dict';
    entries: Record<string, PDFValue>;
}
export interface ContentOperation {
    operator: string;
    operands: PDFValue[];
    /** Half-open byte range from first operand through operator; whitespace/comments before it stay as untouched gaps. */
    start: number;
    end: number;
    /** Set to replacement bytes to edit; an empty array deletes this operation. */
    replacement?: Uint8Array;
    inlineImage?: {
        dict: Record<string, PDFValue>;
        data: Uint8Array;
        editable?: boolean;
        boundary?: string;
        reason?: string;
    };
}
export interface ContentStreamModel {
    bytes: Uint8Array;
    operations: ContentOperation[];
    /** Bytes after the final operation are retained by serializeContent. */
    tailStart: number;
    warnings: string[];
}
export interface FontInfo {
    key: string;
    objNum: number | null;
    resNames: string[];
    baseName: string;
    subset: boolean;
    subtype: 'Type1' | 'TrueType' | 'Type0' | 'Type3' | 'MMType1';
    cidSubtype?: string;
    embedded: boolean;
    fontFile?: {
        kind: 'FontFile' | 'FontFile2' | 'FontFile3';
        subtype?: string;
        objNum: number;
    };
    bold: boolean;
    italic: boolean;
    serif: boolean;
    fixedPitch: boolean;
    ascent: number;
    descent: number;
    standard14?: string;
    wmode: 0 | 1;
    encoding: string;
    hasToUnicode: boolean;
}
export interface BaseObj {
    id: string;
    kind: string;
    bbox: Rect;
    pageBBox: Rect;
    /** Conservative affected rendering region, in user space (stroke, clip and mask extents). */
    renderBBox: Rect;
    editability: { move: boolean; delete: boolean; recolor: boolean; opacity: boolean; reorder: boolean; replace: boolean; crop: boolean; reason?: string };
    ctm: Matrix;
    z: number;
    formPath: string[];
    ops: {
        stream: number;
        first: number;
        last: number;
        streams: number[];
    };
    clipped?: boolean;
    opacity?: {
        fill: number;
        stroke: number;
    };
    markedContent?: string[];
    /** Conservative visible intersection with the active clip; bbox remains intrinsic geometry. */
    clipBBox?: Rect;
}
export interface Glyph {
    code: number;
    unicode: string;
    origin: Point;
    advance: number;
    bbox: Rect;
    /** Text-space displacement, including TJ, before this glyph; useful for precise edits. */
    textMatrix?: Matrix;
    byteLength?: number;
}
export interface TextRun extends BaseObj {
    kind: 'text';
    fontKey: string;
    fontResName: string;
    /** The size given to the Tf operator, in text space. Not the size on the page: see `userSize`. */
    size: number;
    /**
     * Font size as drawn on the page, in user units (points): `size` times the vertical scale of the text
     * matrix and of the page transform. Many producers write `Tf 1` with a 12x text matrix, or draw the
     * whole page under a 0.75 scale; `size` alone is then 1 or 16 for 12-point text.
     */
    userSize: number;
    /** Horizontal and vertical scale from text space to user units, for character spacing, leading and rise. */
    userScale: [number, number];
    textMatrix: Matrix;
    charSpacing: number;
    wordSpacing: number;
    hScale: number;
    rise: number;
    leading: number;
    renderMode: number;
    fill?: RGB;
    stroke?: RGB;
    text: string;
    actualText?: string;
    /** Shared identifier for runs within the same ActualText marked-content span. */
    actualTextSpan?: string;
    glyphs: Glyph[];
    editable: boolean;
}
export interface ImageObj extends BaseObj {
    kind: 'image';
    resName: string;
    objNum: number;
    width: number;
    height: number;
    bpc: number;
    colorSpace: string;
    filter: string[];
    hasSMask: boolean;
    isMask: boolean;
}
export interface InlineImageObj extends BaseObj {
    kind: 'inline-image';
    width: number;
    height: number;
}
export interface PathObj extends BaseObj {
    kind: 'path';
    paint: {
        fill: boolean;
        stroke: boolean;
        evenOdd: boolean;
    };
    fill?: RGB;
    stroke?: RGB;
    lineWidth: number;
    segments: number;
}
export interface FormObj extends BaseObj {
    kind: 'form';
    resName: string;
    objNum: number;
    children: PageObject[];
}
export interface ShadingObj extends BaseObj {
    kind: 'shading';
    resName: string;
}
export type PageObject = TextRun | ImageObj | InlineImageObj | PathObj | FormObj | ShadingObj;
export interface PageModel {
    /** Content fingerprint includes every interpreted page/form stream. */
    revision: string;
    pageIndex: number;
    userToPage: Matrix;
    mediaBox: Rect;
    cropBox: Rect;
    rotate: 0 | 90 | 180 | 270;
    streams: {
        objNum: number | null;
        length: number;
    }[];
    objects: PageObject[];
    fonts: Record<string, FontInfo>;
    warnings: string[];
}
export interface EditResult {
    model: PageModel;
    newIds: Record<string, string[]>;
}
export interface InsertTextSpec {
    font: {
        existingKey?: string;
        program?: Uint8Array;
        name?: string;
    };
    size: number;
    color: RGB;
    origin: Point;
    text?: string;
    glyphs?: {
        gid: number;
        dx: number;
        dy: number;
        advance: number;
    }[];
    actualText?: string;
    matrix?: Matrix;
    markTag?: string;
    /** Shaped-span painting order. Defaults to the logical text's first strong character. */
    direction?: 'ltr' | 'rtl';
    /** Preserve an invisible searchable layer when re-typesetting OCR text. Clipping is not accepted. */
    renderMode?: 0 | 3;
    /** Flattened user-space vector clips captured by getTextReflowState. */
    clip?: string;
}
