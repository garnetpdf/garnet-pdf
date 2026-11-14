// Ambient types for the shaping libraries used by the text editor (engine/text) and the page
// stamps (engine/pages). One declaration per module: TypeScript rejects two differing ones.
declare module 'harfbuzzjs/hb.js' {
  const create: (options?: {
    wasmBinary?: Uint8Array;
    locateFile?: (path: string, prefix: string) => string;
  }) => Promise<unknown>;
  export default create;
}
declare module 'harfbuzzjs/hbjs.js' {
  export interface HBGlyph {
    g: number;
    cl: number;
    ax: number;
    ay: number;
    dx: number;
    dy: number;
    flags?: number;
  }
  export interface HBBlob {
    destroy(): void;
  }
  export interface HBFace {
    upem: number;
    collectUnicodes(): Uint32Array;
    destroy(): void;
  }
  export interface HBFont {
    setScale(x: number, y: number): void;
    destroy(): void;
  }
  export interface HBBuffer {
    addText(text: string): void;
    guessSegmentProperties(): void;
    setDirection(direction: 'ltr' | 'rtl' | 'ttb' | 'btt' | (string & {})): void;
    setScript(script: string): void;
    setLanguage(language: string): void;
    json(): HBGlyph[];
    destroy(): void;
  }
  export interface HarfBuzz {
    createBlob(bytes: ArrayBuffer | Uint8Array): HBBlob;
    createFace(blob: HBBlob, index: number): HBFace;
    createFont(face: HBFace): HBFont;
    createBuffer(): HBBuffer;
    shape(font: HBFont, buffer: HBBuffer, features?: string): void;
  }
  export type HbGlyph = HBGlyph;
  export type HbBlob = HBBlob;
  export type HbFace = HBFace;
  export type HbFont = HBFont;
  export type HbBuffer = HBBuffer;
  const wrap: (module: unknown) => HarfBuzz;
  export default wrap;
}
declare module 'bidi-js' {
  export interface Levels {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }
  export type EmbeddingLevels = Levels;
  export interface Bidi {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl' | 'auto'): Levels;
    getReorderSegments(
      text: string,
      levels: Levels,
      start?: number,
      end?: number,
    ): [number, number][];
    getMirroredCharactersMap(
      text: string,
      levels: Levels,
      start?: number,
      end?: number,
    ): Map<number, string>;
    getMirroredCharacter(char: string): string | null;
  }
  const factory: () => Bidi;
  export default factory;
}
