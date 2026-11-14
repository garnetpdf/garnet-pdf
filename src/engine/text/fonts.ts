import { getFontProgram, type FontInfo } from '@garnet/pdf-content';
import type { PDFDocument } from 'mupdf';
import { bundledFonts } from './bundled';
import { isOpenType, readAsset, supports } from './shaping';
import type { SystemFontInput, TextStyle } from './types';
import { subsetShapingProgram } from './subset-cmap';

export interface ChosenFont {
  family: string;
  program: Uint8Array;
  source: 'original' | 'system' | 'bundled';
  bold: boolean;
  italic: boolean;
  notice?: string;
}
const installed = new Map<string, ChosenFont>();
const bundled = new Map<string, Promise<Uint8Array>>();
/** Actual face style, independent of the PDF's resource/display name. */
function programStyle(program: Uint8Array, fallback: { bold: boolean; italic: boolean }) {
  if (program.length < 12) return fallback;
  const v = new DataView(program.buffer, program.byteOffset, program.byteLength),
    count = v.getUint16(4);
  if (12 + count * 16 > program.length) return fallback;
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16,
      offset = v.getUint32(at + 8),
      length = v.getUint32(at + 12);
    if (v.getUint32(at) === 0x4f532f32 && length >= 64 && offset + length <= program.length) {
      const flags = v.getUint16(offset + 62);
      return { bold: !!(flags & 32) || v.getUint16(offset + 4) >= 700, italic: !!(flags & 1) };
    }
  }
  return fallback;
}
export function normaliseFontName(name: string): {
  family: string;
  bold: boolean;
  italic: boolean;
} {
  const stripped = name.replace(/^[A-Z]{6}\+/, '').replace(/,/g, '-');
  const bold = /bold|black|semibold|demi/i.test(stripped),
    italic = /italic|oblique/i.test(stripped);
  let family = stripped
    .replace(
      /[- ]?(?:bolditalic|boldoblique|semibold|demibold|bold|regular|roman|italic|oblique|black|medium)(?:MT)?$/i,
      '',
    )
    .replace(/(?:PS)?MT$/i, '')
    .replace(/PS$/i, '');
  const aliases: Record<string, string> = {
    timesnewroman: 'Times New Roman',
    arial: 'Arial',
    couriernew: 'Courier New',
    liberationsans: 'Liberation Sans',
    liberationserif: 'Liberation Serif',
    liberationmono: 'Liberation Mono',
    notonaskharabic: 'Noto Naskh Arabic',
    notosansarabic: 'Noto Sans Arabic',
  };
  family = aliases[family.replace(/[\s-]/g, '').toLowerCase()] ?? family;
  return { family: family || 'Carlito', bold, italic };
}
function key(family: string, bold: boolean, italic: boolean) {
  return `${normaliseFontName(family).family.toLowerCase()}:${bold}:${italic}`;
}
export function registerSystemFonts(inputs: SystemFontInput[]): number {
  if (inputs.length > 64) throw new Error('Too many fonts in one request.');
  for (const input of inputs) {
    if (input.bytes.byteLength > 32 * 1024 * 1024) throw new Error('Font file is too large.');
    const program = new Uint8Array(input.bytes),
      style = normaliseFontName(`${input.family}-${input.style}`);
    if (!isOpenType(program)) continue;
    installed.set(key(input.family, style.bold, style.italic), {
      family: input.family,
      program,
      source: 'system',
      bold: style.bold,
      italic: style.italic,
    });
  }
  return installed.size;
}
export function fallbackFamily(name: string, text: string): string {
  if (/\p{Script=Arabic}/u.test(text)) return 'Noto Naskh Arabic';
  if (/calibri|carlito/i.test(name)) return 'Carlito';
  if (/cambria|caladea/i.test(name)) return 'Caladea';
  if (/times|serif/i.test(name) && !/sans/i.test(name)) return 'Liberation Serif';
  if (/courier|mono/i.test(name)) return 'Liberation Mono';
  return 'Liberation Sans';
}
export async function chooseFont(
  doc: PDFDocument,
  info: FontInfo | undefined,
  text: string,
  style: TextStyle,
): Promise<ChosenFont> {
  const originalName = normaliseFontName(info?.baseName ?? 'Carlito');
  const family = normaliseFontName(style.family ?? originalName.family).family;
  if (
    info &&
    !info.subset &&
    info.subtype !== 'Type3' &&
    family === originalName.family &&
    style.bold === info.bold &&
    style.italic === info.italic
  ) {
    const program = getFontProgram(doc, info);
    if (program && (await supports(program, text)))
      return { family, program, source: 'original', ...programStyle(program, style) };
  }
  const exact = installed.get(key(family, style.bold, style.italic));
  if (exact && (await supports(exact.program, text)))
    return { ...exact, notice: `Using ${exact.family} from your installed fonts.` };
  const fallback = fallbackFamily(family, text);
  const candidate = installed.get(key(fallback, style.bold, style.italic));
  if (candidate && (await supports(candidate.program, text)))
    return { ...candidate, notice: `Using ${candidate.family} as a substitute for ${family}.` };
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)) {
    for (const font of installed.values())
      if (await supports(font.program, text))
        return { ...font, notice: `Using ${font.family} for CJK text.` };
    throw new Error(
      'No installed CJK font covers this text. Choose a system font with these characters.',
    );
  }
  const styleName = style.bold
    ? style.italic
      ? 'BoldItalic'
      : 'Bold'
    : style.italic
      ? 'Italic'
      : 'Regular';
  const descriptor =
    bundledFonts.find((f) => f.family === fallback && f.style === styleName) ??
    bundledFonts.find(
      (f) => f.family === fallback && f.style === (style.bold ? 'Bold' : 'Regular'),
    ) ??
    bundledFonts.find((f) => f.family === fallback && f.style === 'Regular')!;
  let program = bundled.get(descriptor.url);
  if (!program) {
    program = readAsset(descriptor.url);
    bundled.set(descriptor.url, program);
  }
  const bytes = await program;
  if (!(await supports(bytes, text)))
    throw new Error(
      `${fallback} does not contain all the requested characters. Choose another installed font.`,
    );
  return {
    family: fallback,
    program: bytes,
    source: 'bundled',
    bold: descriptor.style.includes('Bold'),
    italic: descriptor.style.includes('Italic'),
    notice: `Using ${fallback} as a substitute for ${family}.${style.italic && !descriptor.style.includes('Italic') ? ' Italic is simulated from the available face.' : ''}`,
  };
}
/** FontFace may display an original subset; it is never used to typeset new missing glyphs. */
export async function previewFont(
  doc: PDFDocument,
  info: FontInfo,
  text: string,
  style: TextStyle,
  pageIndex = 0,
): Promise<ChosenFont> {
  let program = getFontProgram(doc, info);
  if (program && info.subset)
    program = subsetShapingProgram(doc, info, program, text, pageIndex) ?? program;
  if (program && isOpenType(program) && (await supports(program, text)))
    return {
      family: normaliseFontName(info.baseName).family,
      program,
      source: 'original',
      ...programStyle(program, info),
    };
  return chooseFont(doc, info, text, style);
}
