import type { FontInfo, Matrix, Point, Rect, RGB } from '@garnet/pdf-content';
import type { OpResult, PageId } from '../../shared/engine-api';
import type { Paragraph } from './paragraphs';

export interface TextStyle {
  fontKey?: string;
  family?: string;
  size: number;
  color: RGB;
  bold: boolean;
  italic: boolean;
  charSpacing: number;
}
export interface StyledText {
  text: string;
  style?: Partial<TextStyle>;
}
export interface SystemFontInput {
  family: string;
  style: string;
  bytes: ArrayBuffer;
}
export interface ParagraphsResult {
  revision: number;
  paragraphs: Paragraph[];
  fonts: FontInfo[];
  userToPage: Matrix;
  rotate: number;
}
export interface TextCommitArgs {
  docId: string;
  pageId: PageId;
  paragraphId?: string;
  expectedRevision: number;
  spans: StyledText[];
  style?: Partial<TextStyle>;
  width?: number;
  alignment?: 'left' | 'right' | 'centre' | 'justified';
  leading?: number;
  /** New box in displayed page coordinates. First baseline is supplied or derived from the size. */
  box?: { bbox: Rect; autoWidth: boolean; baseline?: Point };
}
export interface TextCommitResult extends OpResult {
  tier: 1 | 2;
  notices: string[];
  overlap: boolean;
  paragraphId?: string;
  lineCount: number;
  elapsedMs: number;
}
export interface FontFaceResult {
  fontKey: string;
  family: string;
  bytes: ArrayBuffer;
  bold: boolean;
  italic: boolean;
}
export interface TextPreviewResult {
  png: ArrayBuffer;
  width: number;
  height: number;
  faces: FontFaceResult[];
  notices: string[];
  elapsedMs: number;
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'text.paragraphs': { args: { docId: string; pageId: PageId }; result: ParagraphsResult };
    'text.registerFonts': {
      args: { docId: string; fonts: SystemFontInput[] };
      result: { registered: number };
    };
    'text.preview': {
      args: { docId: string; pageId: PageId; paragraphId: string; scale?: number };
      result: TextPreviewResult;
    };
    'text.commit': { args: TextCommitArgs; result: TextCommitResult };
    'text.transform': {
      args: { docId: string; pageId: PageId; paragraphIds: string[]; matrix: Matrix };
      result: OpResult;
    };
    'text.delete': {
      args: { docId: string; pageId: PageId; paragraphIds: string[] };
      result: OpResult;
    };
  }
}
