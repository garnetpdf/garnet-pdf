import type { LayoutRun } from './layout';

/** Keep ActualText local to a ligature/combining cluster. A whole-run replacement
 * makes some extractors distribute extra Unicode characters onto the next glyph
 * and infer a spurious internal space (for example, "Lati n"). */
export function logicalChunks(run: LayoutRun) {
  let cursor = 0;
  const positioned = run.glyphs.map((g) => {
    const offset = cursor;
    cursor += g.advance;
    return { g, offset };
  });
  const starts = [...new Set(run.glyphs.map((g) => g.cluster))].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number; simple: boolean }> = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i],
      end = starts[i + 1] ?? run.text.length;
    const simple =
      [...run.text.slice(start, end)].length === 1 &&
      run.glyphs.filter((g) => g.cluster === start).length === 1;
    const previous = ranges.at(-1);
    if (simple && previous?.simple) previous.end = end;
    else ranges.push({ start, end, simple });
  }
  return ranges.map(({ start, end }) => {
    const glyphs = positioned.filter(({ g }) => g.cluster >= start && g.cluster < end);
    const offset = glyphs[0].offset;
    return { text: run.text.slice(start, end), offset, glyphs: glyphs.map(({ g }) => g) };
  });
}
