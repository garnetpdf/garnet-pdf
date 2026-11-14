import bidiFactory from 'bidi-js';
import type { PDFDocument } from 'mupdf';
import type { PageModel } from '@garnet/pdf-content';
import type { Paragraph, TextDirection } from './paragraphs';
import { chooseFont, normaliseFontName, type ChosenFont } from './fonts';
import { shape } from './shaping';
import type { StyledText, TextCommitArgs, TextStyle } from './types';
import { hasSimulatedItalic } from './style';

const bidi = bidiFactory();
export interface LayoutRun {
  text: string;
  start: number;
  end: number;
  style: TextStyle;
  font: ChosenFont;
  direction: TextDirection;
  x: number;
  width: number;
  glyphs: { gid: number; dx: number; dy: number; advance: number; cluster: number }[];
}
export interface LayoutLine {
  text: string;
  start: number;
  end: number;
  baseline: number;
  runs: LayoutRun[];
  width: number;
}
export interface ParagraphLayout {
  text: string;
  lines: LayoutLine[];
  width: number;
  leading: number;
  notices: string[];
  overflow: boolean;
}
export const defaultStyle: TextStyle = {
  family: 'Carlito',
  size: 12,
  color: [0, 0, 0],
  bold: false,
  italic: false,
  charSpacing: 0,
};
function checkedStyle(style: TextStyle): TextStyle {
  if (
    !Number.isFinite(style.size) ||
    style.size < 1 ||
    style.size > 512 ||
    !Number.isFinite(style.charSpacing) ||
    Math.abs(style.charSpacing) > 100 ||
    style.color.length !== 3 ||
    !style.color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)
  )
    throw new Error('Invalid paragraph formatting.');
  return style;
}
function script(text: string): string {
  return /\p{Script=Arabic}/u.test(text)
    ? 'arabic'
    : /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)
      ? 'cjk'
      : /[\p{Letter}\p{Number}]/u.test(text)
        ? 'other'
        : '';
}
function styledSpans(p: Paragraph | undefined, args: TextCommitArgs): StyledText[] {
  if (!p || args.spans.some((s) => s.style) || args.style) return args.spans;
  // Carry unchanged formatting over a plain-text edit. Newly typed characters inherit
  // the style at the insertion point, rather than flattening a mixed paragraph.
  const newText = args.spans.map((s) => s.text).join(''),
    old = p.text;
  const styles: Array<Partial<TextStyle> | undefined> = Array(old.length);
  const seen = new Set<string>(),
    styleCache = new Map<string, Partial<TextStyle>>();
  let from = 0;
  for (const line of p.lines)
    for (const run of p.boxTag ? [...line.runs].sort((a, b) => a.z - b.z) : line.runs) {
      if (run.actualTextSpan && seen.has(run.actualTextSpan)) continue;
      if (run.actualTextSpan) seen.add(run.actualTextSpan);
      const text = run.actualText ?? run.text,
        at = old.indexOf(text, from);
      if (at < 0 || !text) continue;
      const candidate = {
        fontKey: run.fontKey,
        // as drawn on the page (see TextRun.userSize): the new text is written in page units
        size: run.userSize,
        color: run.fill ?? p.dominantStyle.color,
        charSpacing: run.charSpacing * run.userScale[0],
        ...(hasSimulatedItalic(run) ? { italic: true } : {}),
      };
      const key = JSON.stringify(candidate),
        s = styleCache.get(key) ?? candidate;
      styleCache.set(key, s);
      styles.fill(s, at, at + text.length);
      from = at + text.length;
    }
  let prefix = 0,
    suffix = 0;
  while (prefix < old.length && prefix < newText.length && old[prefix] === newText[prefix])
    prefix++;
  while (
    suffix < old.length - prefix &&
    suffix < newText.length - prefix &&
    old.at(-suffix - 1) === newText.at(-suffix - 1)
  )
    suffix++;
  const out: StyledText[] = [];
  for (let i = 0; i < newText.length; i++) {
    const index =
      i < prefix
        ? i
        : i >= newText.length - suffix
          ? old.length - (newText.length - i)
          : Math.max(0, prefix - 1);
    const style = styles[index];
    if (out.length && out.at(-1)!.style === style) out.at(-1)!.text += newText[i];
    else out.push({ text: newText[i], style });
  }
  return out;
}

export async function layoutParagraph(
  doc: PDFDocument,
  model: PageModel,
  p: Paragraph | undefined,
  args: TextCommitArgs,
): Promise<ParagraphLayout> {
  const base = checkedStyle({ ...defaultStyle, ...p?.dominantStyle, ...args.style });
  const autoWidth = args.box?.autoWidth ?? (p?.autoWidth && args.width === undefined) ?? false;
  const width = autoWidth
    ? 100000
    : (args.width ?? (args.box ? args.box.bbox[2] - args.box.bbox[0] : p!.bbox[2] - p!.bbox[0]));
  const leading = args.leading ?? p?.leading ?? base.size * 1.2;
  if (
    !Number.isFinite(width) ||
    width < 1 ||
    width > 100000 ||
    !Number.isFinite(leading) ||
    leading < 1 ||
    leading > 1024
  )
    throw new Error('Invalid paragraph dimensions.');
  const spans = styledSpans(p, args),
    text = spans.map((s) => s.text.replace(/\r\n?/g, '\n')).join('');
  if (text.length > 100000) throw new Error('This paragraph is too long to edit in one operation.');
  const direction =
    p?.direction ??
    (/^[^\p{Letter}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text) ? 'rtl' : 'ltr');
  const hangingIndent = Math.max(0, Math.min(p?.hangingIndent ?? 0, width - 1));
  const levels = bidi.getEmbeddingLevels(text, direction);
  interface Segment {
    start: number;
    end: number;
    style: TextStyle;
    script: string;
    font?: ChosenFont;
    level: number;
  }
  const segments: Segment[] = [];
  let offset = 0;
  for (const span of spans) {
    const value = span.text.replace(/\r\n?/g, '\n'),
      info = model.fonts[span.style?.fontKey ?? base.fontKey ?? ''];
    const style = checkedStyle({
      ...base,
      ...(info
        ? { family: normaliseFontName(info.baseName).family, bold: info.bold, italic: info.italic }
        : {}),
      ...args.style,
      // Explicit selection formatting wins over the paragraph's default style.
      ...span.style,
    });
    const graphemes = [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ];
    let lastScript = '';
    for (let i = 0; i < graphemes.length; i++) {
      const g = graphemes[i],
        start = offset + g.index,
        end = start + g.segment.length;
      const sc =
        script(g.segment) ||
        lastScript ||
        graphemes
          .slice(i + 1)
          .map((g) => script(g.segment))
          .find(Boolean) ||
        'other';
      lastScript = sc;
      const previous = segments.at(-1),
        level = levels.levels[start] ?? 0;
      if (
        previous &&
        previous.style === style &&
        previous.script === sc &&
        previous.level === level
      )
        previous.end = end;
      else segments.push({ start, end, style, script: sc, level });
    }
    offset += value.length;
  }
  const notices = new Set<string>();
  for (const segment of segments) {
    segment.font = await chooseFont(
      doc,
      model.fonts[segment.style.fontKey ?? ''],
      text.slice(segment.start, segment.end).replace(/\n/g, ''),
      segment.style,
    );
    if (segment.font.notice) notices.add(segment.font.notice);
  }
  const cache = new Map<string, Promise<LayoutRun[]>>();
  const runsFor = (start: number, end: number): Promise<LayoutRun[]> => {
    const key = `${start}:${end}`;
    if (cache.has(key)) return cache.get(key)!;
    const pending = Promise.all(
      segments
        .filter((s) => s.end > start && s.start < end)
        .map(async (s) => {
          const a = Math.max(s.start, start),
            b = Math.min(s.end, end),
            value = text.slice(a, b),
            dir: TextDirection = s.level % 2 ? 'rtl' : 'ltr';
          const shaped = await shape(
            s.font!.program,
            value,
            s.style.size,
            dir,
            s.style.charSpacing,
          );
          if (shaped.glyphs.some((g) => g.g === 0))
            throw new Error(`The selected font cannot shape "${value}".`);
          return {
            text: value,
            start: a,
            end: b,
            style: s.style,
            font: s.font!,
            direction: dir,
            x: 0,
            width: shaped.width,
            glyphs: shaped.glyphs.map((g) => ({
              gid: g.g,
              dx: g.dx,
              dy: g.dy,
              advance: g.ax,
              cluster: g.cl,
            })),
          };
        }),
    );
    cache.set(key, pending);
    return pending;
  };
  const measure = async (a: number, b: number) =>
    (await runsFor(a, b)).reduce((n, r) => n + r.width, 0);
  const boundaries: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!,
      c = String.fromCodePoint(cp),
      end = i + c.length;
    if (
      /[\s-]/u.test(c) ||
      /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(c)
    )
      boundaries.push(end);
    i = end;
  }
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length);
  const lineRanges: Array<[number, number]> = [];
  let start = 0,
    best = 0;
  for (const end of boundaries) {
    const candidate = text.slice(start, end),
      hard = candidate.endsWith('\n'),
      trimmedEnd = end - (candidate.match(/[ \t\n]+$/)?.[0].length ?? 0);
    const w = await measure(start, trimmedEnd);
    const available = width - (lineRanges.length ? hangingIndent : 0);
    if (w > available + 0.01 && best > start) {
      lineRanges.push([start, best]);
      start = best;
    }
    best = end;
    if (hard) {
      lineRanges.push([start, end]);
      start = end;
      best = end;
    }
  }
  if (start < text.length) lineRanges.push([start, text.length]);
  if (!lineRanges.length && !text)
    return { text, lines: [], width: 0, leading, notices: [...notices], overflow: false };
  const frameWidth = autoWidth
    ? Math.max(
        1,
        ...(await Promise.all(
          lineRanges.map(([a, b]) =>
            measure(a, b - (text.slice(a, b).match(/[ \t\n]+$/)?.[0].length ?? 0)),
          ),
        )),
      )
    : width;
  const alignment = args.alignment ?? p?.alignment ?? (direction === 'rtl' ? 'right' : 'left');
  const firstBaseline =
    args.box?.baseline?.[1] ?? p?.lines[0].baseline ?? args.box!.bbox[1] + base.size;
  const left = args.box?.bbox[0] ?? p!.bbox[0];
  let overflow = false;
  const lines: LayoutLine[] = [];
  for (let i = 0; i < lineRanges.length; i++) {
    const [a, end] = lineRanges[i],
      b = end - (text.slice(a, end).match(/[ \t\n]+$/)?.[0].length ?? 0);
    const runs = await runsFor(a, b);
    const natural = runs.reduce((n, r) => n + r.width, 0);
    const inset = i ? hangingIndent : 0,
      available = frameWidth - inset;
    overflow ||= natural > available + 0.02;
    // UAX #9 reordering is applied to each wrapped line, including trailing reset.
    const indices = Array.from({ length: b - a }, (_, j) => a + j);
    for (const [from, to] of bidi.getReorderSegments(text, levels, a, Math.max(a, b - 1))) {
      const part = indices.slice(from - a, to - a + 1).reverse();
      indices.splice(from - a, part.length, ...part);
    }
    const rank = new Map(indices.map((n, j) => [n, j]));
    const visual = [...runs].sort(
      (r, s) =>
        Math.min(...Array.from({ length: r.end - r.start }, (_, j) => rank.get(r.start + j) ?? 0)) -
        Math.min(...Array.from({ length: s.end - s.start }, (_, j) => rank.get(s.start + j) ?? 0)),
    );
    let x =
      left +
      (direction === 'rtl' ? 0 : inset) +
      (alignment === 'right'
        ? available - natural
        : alignment === 'centre'
          ? (available - natural) / 2
          : 0);
    const spaces = text.slice(a, b).split(' ').length - 1;
    const extra =
      alignment === 'justified' &&
      i < lineRanges.length - 1 &&
      spaces > 0 &&
      !text.slice(a, end).endsWith('\n')
        ? Math.max(0, (available - natural) / spaces)
        : 0;
    for (const run of visual) {
      run.x = x;
      // HarfBuzz cluster indices are UTF-16. A standalone space always shapes to one glyph;
      // expand its advance and keep the following glyph offsets untouched.
      if (extra) {
        const shaped = await shape(
          run.font.program,
          run.text,
          run.style.size,
          run.direction,
          run.style.charSpacing,
        );
        run.glyphs = run.glyphs.map((g, j) => ({
          ...g,
          advance: g.advance + (run.text[shaped.glyphs[j].cl] === ' ' ? extra : 0),
        }));
        run.width = run.glyphs.reduce((n, g) => n + g.advance, 0);
      }
      x += run.width;
    }
    // Keep logical insertion order; x contains the per-line visual position.
    lines.push({
      text: text.slice(a, b),
      start: a,
      end: b,
      baseline: firstBaseline + i * leading,
      runs,
      width: x - left,
    });
  }
  return { text, lines, width: frameWidth, leading, notices: [...notices], overflow };
}
