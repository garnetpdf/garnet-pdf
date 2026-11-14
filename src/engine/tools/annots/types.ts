/**
 * Wire types shared by the annotation engine ops and the Comment / Fill & Sign plugins.
 * Geometry is in MuPDF page space: points, top-left origin, y down, page /Rotate applied
 * (the same space as `core.text` quads and the rendered page canvas).
 */
import type { PageId, Quad, Rect } from '../../../shared/engine-api';

export type Point = [number, number];
export type RGB = [number, number, number];
export type LineEnding =
  | 'None'
  | 'Square'
  | 'Circle'
  | 'Diamond'
  | 'OpenArrow'
  | 'ClosedArrow'
  | 'Butt'
  | 'ROpenArrow'
  | 'RClosedArrow'
  | 'Slash';
/** Marker for annotations placed by Fill & Sign, stored as a private name in the annotation dictionary. */
export type FillSignKind = 'signature' | 'initials' | 'text' | 'date' | 'tick' | 'cross' | 'dot';
export const FILL_SIGN_KINDS: readonly FillSignKind[] = [
  'signature',
  'initials',
  'text',
  'date',
  'tick',
  'cross',
  'dot',
];

export type CreatableType =
  | 'Highlight'
  | 'Underline'
  | 'StrikeOut'
  | 'Squiggly'
  | 'Text'
  | 'FreeText'
  | 'Square'
  | 'Circle'
  | 'Line'
  | 'PolyLine'
  | 'Polygon'
  | 'Ink'
  | 'Stamp';

export interface AnnotSummary {
  /** Indirect object number of the annotation dictionary. Stable across undo/redo. */
  id: number;
  pageId: PageId;
  pageIndex: number;
  type: string;
  bounds: Rect;
  rect?: Rect;
  contents: string;
  author: string;
  subject: string;
  created?: number;
  modified?: number;
  color: RGB | null;
  interiorColor: RGB | null;
  opacity: number;
  borderWidth?: number;
  borderStyle?: string;
  dashes?: number[];
  borderEffect?: 'None' | 'Cloudy';
  intent?: string;
  icon?: string;
  quads?: Quad[];
  vertices?: Point[];
  line?: [Point, Point];
  lineEndings?: { start: LineEnding; end: LineEnding };
  ink?: Point[][];
  callout?: Point[];
  font?: string;
  fontSize?: number;
  textColor?: RGB | null;
  align?: number;
  /** Parent annotation (In Reply To). */
  irt?: number;
  hidden: boolean;
  locked: boolean;
  fillSign?: FillSignKind;
  isOpen?: boolean;
}

export interface AnnotStyle {
  color?: RGB | null;
  interiorColor?: RGB | null;
  opacity?: number;
  borderWidth?: number;
  borderStyle?: 'Solid' | 'Dashed';
  dashes?: number[];
  borderEffect?: 'None' | 'Cloudy';
  fontSize?: number;
  textColor?: RGB;
  align?: 0 | 1 | 2;
  lineEndings?: { start: LineEnding; end: LineEnding };
  icon?: string;
}

export interface AnnotCreateSpec extends AnnotStyle {
  type: CreatableType;
  rect?: Rect;
  quads?: Quad[];
  vertices?: Point[];
  line?: [Point, Point];
  ink?: Point[][];
  /** FreeText callout: [arrow tip, knee, point on the text box] or [tip, box point]. */
  callout?: Point[];
  intent?: string;
  contents?: string;
  author?: string;
  subject?: string;
  /** PNG or JPEG bytes for an image stamp (custom stamp or signature). */
  image?: ArrayBuffer;
  fillSign?: FillSignKind;
}

export interface AnnotPatch extends AnnotStyle {
  contents?: string;
  author?: string;
  subject?: string;
  isOpen?: boolean;
  /** Replace the rectangle (FreeText auto-grow, numeric geometry). */
  rect?: Rect;
}

export interface AnnotRef {
  pageId: PageId;
  id: number;
}

export interface AnnotListResult {
  revision: number;
  items: AnnotSummary[];
}

export type FlattenScope = 'comments' | 'fill-sign' | 'selected';
