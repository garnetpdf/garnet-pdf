import {
  encodeText,
  getFontProgram,
  measureCodes,
  type PageModel,
  type TextRun,
} from '@garnet/pdf-content';
import type { PDFDocument } from 'mupdf';
import { shape, isOpenType } from './shaping';
import { subsetShapingProgram } from './subset-cmap';
import type { Paragraph } from './paragraphs';
import type { TextCommitArgs } from './types';
export interface RunReplacement {
  id: string;
  text: string;
}
/** Conservative Tier 1: one changed run, with original line boundaries and style. */
export async function planTier1(
  doc: PDFDocument,
  model: PageModel,
  p: Paragraph,
  args: TextCommitArgs,
): Promise<RunReplacement[] | null> {
  if (
    args.width !== undefined ||
    args.style ||
    args.alignment ||
    args.leading ||
    args.box ||
    args.spans.some((s) => s.style && Object.keys(s.style).length)
  )
    return null;
  const text = args.spans.map((s) => s.text).join('');
  if (text === p.text) return [];
  if (/[\n\r]/.test(text)) return null;
  let prefix = 0,
    suffix = 0;
  while (prefix < text.length && prefix < p.text.length && text[prefix] === p.text[prefix])
    prefix++;
  while (
    suffix < text.length - prefix &&
    suffix < p.text.length - prefix &&
    text.at(-suffix - 1) === p.text.at(-suffix - 1)
  )
    suffix++;
  let from = 0;
  for (const line of p.lines)
    for (const run of line.runs) {
      const at = p.text.indexOf(run.text, from);
      if (at < 0) continue;
      from = at + run.text.length;
      if (prefix < at || p.text.length - suffix > from) continue;
      const value =
        run.text.slice(0, prefix - at) +
        text.slice(prefix, text.length - suffix) +
        run.text.slice(p.text.length - suffix - at);
      if (
        !run.editability.replace ||
        run.actualText !== undefined ||
        /[\p{Mark}\u0590-\u109f\u1780-\u17ff\ufb1d-\ufeff]/u.test(run.text + value)
      )
        return null;
      const font = model.fonts[run.fontKey],
        encoded = encodeText(doc, font, value);
      if (encoded.missing.length) return null;
      let program = getFontProgram(doc, font);
      if (program && font.subset)
        program =
          subsetShapingProgram(doc, font, program, run.text + value, model.pageIndex) ?? program;
      if (program && isOpenType(program)) {
        // Even a Latin change can introduce fi/ff ligatures or a combining cluster.
        // Validate both sides with the actual program before writing original codes.
        for (const candidate of [run.text, value]) {
          const result = await shape(program, candidate, run.size, 'ltr');
          if (
            result.glyphs.some((g) => g.g === 0) ||
            result.glyphs.length !== [...candidate].length ||
            new Set(result.glyphs.map((g) => g.cl)).size !== result.glyphs.length
          )
            return null;
        }
      } else if (!font.standard14 && font.subtype !== 'Type1') return null;
      const advance = (r: TextRun, t: string) =>
        measureCodes(
          doc,
          model.fonts[r.fontKey],
          encodeText(doc, model.fonts[r.fontKey], t).codes,
          r.size,
          r.charSpacing,
          r.wordSpacing,
          r.hScale,
        );
      const oldWidth = line.runs.reduce((n, r) => n + advance(r, r.text), 0);
      const newWidth = oldWidth - advance(run, run.text) + advance(run, value);
      if (newWidth > oldWidth * 1.02 + 0.01) return null;
      return [{ id: run.id, text: value }];
    }
  return null;
}
