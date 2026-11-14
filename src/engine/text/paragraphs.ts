import {
  concat,
  flattenObjects,
  invert,
  point,
  transformRect,
  type Matrix,
  type PageModel,
  type PageObject,
  type PathObj,
  type Point,
  type RGB,
  type Rect,
  type TextRun,
} from '@garnet/pdf-content';
import { hasSimulatedItalic } from './style';

export type TextDirection = 'ltr' | 'rtl';
export type TextAlignment = 'left' | 'right' | 'centre' | 'justified';
export interface ParagraphLine {
  /** Page-space y of baselinePoint. Use layoutBaseline for typesetting. */
  baseline: number;
  baselinePoint: Point;
  /** Baseline and box in unrotated, top-left-origin layout space. */
  layoutBaseline: number;
  layoutBBox: Rect;
  bbox: Rect;
  runs: TextRun[];
  text: string;
  direction: TextDirection;
}
export interface ParagraphStyle {
  fontKey: string;
  family?: string;
  size: number;
  color: RGB;
  bold: boolean;
  italic: boolean;
  charSpacing: number;
}
export interface Paragraph {
  id: string;
  /** Rotated, top-left-origin page space. */
  bbox: Rect;
  /** Unrotated top-left geometry for paragraph reflow. */
  layoutBBox: Rect;
  layoutToPage: Matrix;
  lines: ParagraphLine[];
  direction: TextDirection;
  alignment: TextAlignment;
  leading: number;
  dominantStyle: ParagraphStyle;
  text: string;
  readOnly: boolean;
  reason?: string;
  invisible: boolean;
  boxTag?: string;
  autoWidth?: boolean;
  /** Continuation-line inset, measured from an existing list's first line. */
  hangingIndent?: number;
}

/**
 * The run whose style most of the line is written in. Runs are counted together by font, size and
 * colour: after a rewrite every glyph is its own run, and the longest single run would be the first
 * glyph, often a bullet or a large capital in another font.
 */
function dominantRun(runs: TextRun[]): TextRun {
  const groups = new Map<string, { run: TextRun; glyphs: number }>();
  for (const run of runs) {
    const colour = (run.fill ?? [0, 0, 0]).map((c) => Math.round(c * 255)).join(',');
    const key = `${run.fontKey}|${Math.round(drawnSize(run) * 100)}|${colour}`;
    const group = groups.get(key);
    if (group) group.glyphs += run.glyphs.length;
    else groups.set(key, { run, glyphs: run.glyphs.length });
  }
  let best: { run: TextRun; glyphs: number } | undefined;
  for (const group of groups.values()) if (!best || group.glyphs > best.glyphs) best = group;
  return best ? best.run : runs[0];
}

const arabic = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const latin = /[\p{L}\p{N}]/u;
const alef = /^[اأإآ]$/u;
const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const width = (b: Rect) => b[2] - b[0];
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
function firstStrong(text: string): TextDirection {
  for (const c of text) {
    if (arabic.test(c)) return 'rtl';
    if (latin.test(c)) return 'ltr';
  }
  return 'ltr';
}
interface Cluster {
  text: string;
  x: number;
  span?: string;
}
/** PDF glyphs are often painted in visual order; reconstruct RTL clusters and LTR islands. */
function logicalRTL(runs: TextRun[]): string {
  const glyphs = runs.flatMap((run) => run.glyphs.map((g) => ({ glyph: g, run })));
  const clusters: Cluster[] = [];
  const seenSpans = new Set<string>();
  for (let i = 0; i < glyphs.length; i++) {
    const { glyph, run } = glyphs[i];
    if (run.actualTextSpan) {
      if (!seenSpans.has(run.actualTextSpan)) {
        clusters.push({
          text: run.actualText ?? run.text,
          x: glyph.origin[0],
          span: run.actualTextSpan,
        });
        seenSpans.add(run.actualTextSpan);
      }
      continue;
    }
    const next = glyphs[i + 1];
    // LibreOffice emits lam-alef as a zero-advance alef followed by the lam
    // at the same origin. Treat them as one glyph cluster before reordering.
    if (
      alef.test(glyph.unicode) &&
      Math.abs(glyph.advance) < 0.01 &&
      next?.glyph.unicode === 'ل' &&
      Math.abs(next.glyph.origin[0] - glyph.origin[0]) < 0.11
    ) {
      clusters.push({ text: `ل${glyph.unicode}`, x: glyph.origin[0] });
      i++;
      continue;
    }
    if (
      clusters.length &&
      Math.abs(glyph.advance) < 0.01 &&
      Math.abs(clusters[clusters.length - 1].x - glyph.origin[0]) < 0.11
    ) {
      clusters[clusters.length - 1].text += glyph.unicode;
    } else clusters.push({ text: glyph.unicode, x: glyph.origin[0] });
  }
  // Descending position is RTL reading order. Equal positions keep source order.
  clusters.sort((a, b) => b.x - a.x);
  const kind = clusters.map((c) => (arabic.test(c.text) ? 'R' : latin.test(c.text) ? 'L' : null));
  // Neutrals within an LTR island, including the hyphens and slashes in dates,
  // should retain the island's LTR order.
  for (let i = 0; i < kind.length;) {
    if (kind[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < kind.length && !kind[end]) end++;
    const assigned =
      i > 0 && end < kind.length && kind[i - 1] === 'L' && kind[end] === 'L' ? 'L' : 'R';
    kind.fill(assigned, i, end);
    i = end;
  }
  for (let i = 0; i < kind.length;) {
    let end = i + 1;
    while (end < kind.length && kind[end] === kind[i]) end++;
    if (kind[i] === 'L') clusters.splice(i, end - i, ...clusters.slice(i, end).reverse());
    i = end;
  }
  return clusters.map((c) => c.text).join('');
}

function logicalLine(runs: TextRun[], dir: TextDirection): string {
  // Our own spans are written in logical order with per-span ActualText.
  // Geometry reordering would reverse whole script/style spans a second time.
  if (
    runs.every(
      (r) => r.actualTextSpan && r.markedContent?.some((t) => t.startsWith('GarnetTextBox_')),
    )
  ) {
    const seen = new Set<string>();
    return [...runs]
      .sort((a, b) => a.z - b.z)
      .map((r) => {
        if (seen.has(r.actualTextSpan!)) return '';
        seen.add(r.actualTextSpan!);
        return r.actualText ?? r.text;
      })
      .join('');
  }
  if (dir === 'rtl') return logicalRTL(runs);
  const seen = new Set<string>();
  return runs
    .map((run) => {
      if (!run.actualTextSpan) return run.actualText ?? run.text;
      if (seen.has(run.actualTextSpan)) return '';
      seen.add(run.actualTextSpan);
      return run.actualText ?? run.text;
    })
    .join('');
}

function lineDirection(runs: TextRun[]): TextDirection {
  // The rightmost run gives the first strong character in a mixed RTL line.
  const rightmost = [...runs].sort((a, b) => b.pageBBox[2] - a.pageBBox[2]);
  for (const run of rightmost) {
    for (const c of run.actualText ?? run.text) {
      if (arabic.test(c)) return 'rtl';
      if (latin.test(c)) return 'ltr';
    }
  }
  return 'ltr';
}

/**
 * Sizes on the page, not the numbers in the operators. A run's `size` and `leading` are in text space; many
 * files write `Tf 1` with a 12x text matrix or draw the page under a 0.75 scale, so those numbers can be 1
 * or 16 for 12-point text. Everything here compares against distances on the page.
 */
const drawnSize = (run: TextRun): number => run.userSize;
const drawnLeading = (run: TextRun): number =>
  run.leading > 0 ? run.leading * run.userScale[1] : 0;

/** First index whose value is not below `value` in an ascending list. */
function lowerBound(values: number[], value: number): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Stroked paths by the x position of their left and right edges, so "is there a ruling line between these two
 * runs" looks only at paths near that x. Scanning every path for every gap froze text editing on drawings
 * with tens of thousands of paths.
 */
function rulingIndex(paths: PathObj[]): (a: TextRun, b: TextRun) => boolean {
  const edges: { x: number; path: PathObj }[] = [];
  for (const path of paths) {
    if (!path.paint.stroke) continue;
    if (Number.isFinite(path.pageBBox[0])) edges.push({ x: path.pageBBox[0], path });
    if (Number.isFinite(path.pageBBox[2])) edges.push({ x: path.pageBBox[2], path });
  }
  edges.sort((p, q) => p.x - q.x);
  const xs = edges.map((e) => e.x);
  return (a, b) => {
    const x = (a.pageBBox[2] + b.pageBBox[0]) / 2;
    const y = (Math.max(a.pageBBox[1], b.pageBBox[1]) + Math.min(a.pageBBox[3], b.pageBBox[3])) / 2;
    if (!Number.isFinite(x)) return false;
    for (let i = lowerBound(xs, x - 1.5); i < edges.length && edges[i].x < x + 1.5; i++) {
      const p = edges[i].path.pageBBox;
      if (
        (Math.abs(p[0] - x) < 1.5 || Math.abs(p[2] - x) < 1.5) &&
        p[1] <= y &&
        p[3] >= y &&
        p[3] - p[1] > Math.min(drawnSize(a), drawnSize(b)) * 0.8
      )
        return true;
    }
    return false;
  };
}

function classifyAlignment(lines: ParagraphLine[], direction: TextDirection): TextAlignment {
  if (lines.length === 1) return direction === 'rtl' ? 'right' : 'left';
  const left = lines.map((l) => l.bbox[0]);
  const right = lines.map((l) => l.bbox[2]);
  const centre = lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2);
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const tolerance = Math.max(2, drawnSize(lines[0].runs[0]) * 0.3);
  if (spread(left) <= tolerance && spread(right) <= tolerance) return 'justified';
  if (spread(centre) <= tolerance) return 'centre';
  if (spread(right) <= tolerance && direction === 'rtl') return 'right';
  if (spread(left) <= tolerance) return 'left';
  return direction === 'rtl' ? 'right' : 'left';
}

function canJoin(prev: ParagraphLine, next: ParagraphLine): boolean {
  const size = drawnSize(prev.runs[0]);
  if (Math.abs(drawnSize(next.runs[0]) - size) > size * 0.15) return false;
  if (prev.direction !== next.direction) return false;
  const delta = next.baseline - prev.baseline;
  const lead = drawnLeading(prev.runs[0]) || size * 1.2;
  if (delta <= size * 0.3 || delta > lead * 1.6) return false;
  if (overlap(prev.bbox, next.bbox) < Math.min(width(prev.bbox), width(next.bbox)) * 0.25)
    return false;
  const primary =
    prev.direction === 'rtl'
      ? Math.abs(prev.bbox[2] - next.bbox[2])
      : Math.abs(prev.bbox[0] - next.bbox[0]);
  // A list bullet can protrude by about one em without splitting the body.
  const listStart = /^(?:[•◦▪‣*-]|\d+[.)])\s/u.test(prev.text);
  if (primary > size * (listStart ? 2 : 1.2)) return false;
  return true;
}

function detectLayoutParagraphs(model: PageModel): Paragraph[] {
  const all = flattenObjects(model.objects);
  const paths = all.filter((o): o is PathObj => o.kind === 'path');
  const textRuns = all.filter(
    (o): o is TextRun =>
      o.kind === 'text' && o.glyphs.length > 0 && (o.text.length > 0 || o.actualText !== undefined),
  );
  // Geometry order, not content-stream order: Chrome paints characters and columns interleaved.
  textRuns.sort((a, b) => {
    const ay = a.glyphs[0] ? point(a.glyphs[0].origin, model.userToPage)[1] : a.pageBBox[3];
    const by = b.glyphs[0] ? point(b.glyphs[0].origin, model.userToPage)[1] : b.pageBBox[3];
    return ay - by || a.pageBBox[0] - b.pageBBox[0];
  });
  const baselineRows: TextRun[][] = [];
  // Baseline of each row's first run. Runs arrive sorted by baseline, so this list ascends and only its tail
  // (rows within 0.3 of the run's size) can match; the first match wins, as a scan from the start would find.
  const rowBaselines: number[] = [];
  let ascending = true;
  for (const run of textRuns) {
    const baseline = run.glyphs[0]
      ? point(run.glyphs[0].origin, model.userToPage)[1]
      : run.pageBBox[3];
    const from = ascending ? lowerBound(rowBaselines, baseline - drawnSize(run) * 0.3) : 0;
    let row: TextRun[] | undefined;
    for (let k = from; k < baselineRows.length; k++) {
      if (
        Math.abs(baseline - rowBaselines[k]) <=
        Math.min(drawnSize(run), drawnSize(baselineRows[k][0])) * 0.3
      ) {
        row = baselineRows[k];
        break;
      }
    }
    if (row) row.push(run);
    else {
      if (rowBaselines.length && !(baseline >= rowBaselines[rowBaselines.length - 1]))
        ascending = false;
      baselineRows.push([run]);
      rowBaselines.push(baseline);
    }
  }
  const columnStarts = baselineRows.flatMap((row) => {
    const ordered = [...row].sort((a, b) => a.pageBBox[0] - b.pageBBox[0]);
    let reach = ordered[0]?.pageBBox[2] ?? 0;
    return ordered.slice(1).flatMap((run) => {
      const separate = run.pageBBox[0] - reach > drawnSize(run) * 2;
      reach = Math.max(reach, run.pageBBox[2]);
      return separate ? [{ x: run.pageBBox[0], y: run.pageBBox[1], size: drawnSize(run) }] : [];
    });
  });
  // Column starts by x, so a run is compared only with the starts near its own left edge.
  const columnsByX = columnStarts.every((c) => Number.isFinite(c.x))
    ? [...columnStarts].sort((p, q) => p.x - q.x)
    : undefined;
  const columnXs = columnsByX?.map((c) => c.x) ?? [];
  const startsRepeatedColumn = (run: TextRun): boolean => {
    const matches = (c: { x: number; y: number; size: number }) =>
      Math.abs(c.x - run.pageBBox[0]) < Math.min(drawnSize(run), c.size) * 0.3 &&
      Math.abs(c.y - run.pageBBox[1]) < drawnSize(run) * 4 &&
      c.y !== run.pageBBox[1];
    if (!columnsByX || !Number.isFinite(run.pageBBox[0])) return columnStarts.some(matches);
    const reach = drawnSize(run) * 0.3;
    for (
      let i = lowerBound(columnXs, run.pageBBox[0] - reach);
      i < columnsByX.length && columnsByX[i].x <= run.pageBBox[0] + reach;
      i++
    )
      if (matches(columnsByX[i])) return true;
    return false;
  };
  const ruling = rulingIndex(paths);
  const lines: ParagraphLine[] = [];
  for (const row of baselineRows) {
    row.sort((a, b) => a.pageBBox[0] - b.pageBBox[0]);
    let group: TextRun[] = [];
    let groupReach = -Infinity;
    const flush = () => {
      if (!group.length) return;
      const bbox = group.map((r) => r.pageBBox).reduce(union);
      const baseline =
        group.reduce(
          (sum, r) =>
            sum + (r.glyphs[0] ? point(r.glyphs[0].origin, model.userToPage)[1] : r.pageBBox[3]),
          0,
        ) / group.length;
      const direction = lineDirection(group);
      lines.push({
        baseline,
        baselinePoint: [bbox[0], baseline],
        layoutBaseline: baseline,
        layoutBBox: [...bbox],
        bbox,
        runs: group,
        text: logicalLine(group, direction),
        direction,
      });
      group = [];
      groupReach = -Infinity;
    };
    for (const run of row) {
      if (group.length) {
        const prev = group[group.length - 1];
        const gap = run.pageBBox[0] - groupReach;
        if (
          gap > Math.min(drawnSize(prev), drawnSize(run)) * 2 ||
          (gap > 0 && ruling(prev, run)) ||
          (gap > 0 && startsRepeatedColumn(run))
        )
          flush();
      }
      group.push(run);
      // Same value as the largest right edge in the group (a NaN edge makes it NaN, as Math.max would).
      groupReach = Math.max(groupReach, run.pageBBox[2]);
    }
    flush();
  }
  lines.sort((a, b) => a.baseline - b.baseline || a.bbox[0] - b.bbox[0]);
  const styleOfRun = (run: TextRun): ParagraphStyle => {
    const font = model.fonts[run.fontKey];
    return {
      fontKey: run.fontKey,
      size: drawnSize(run),
      color: run.fill ?? [0, 0, 0],
      bold: Boolean(font?.bold),
      italic: Boolean(font?.italic) || hasSimulatedItalic(run),
      charSpacing: run.charSpacing * run.userScale[0],
    };
  };
  const paragraphs: Paragraph[] = [];
  // The newest paragraph a line can join, found without rescanning every paragraph for every line: tagged text
  // boxes by their tag; untagged paragraphs from a list that drops a paragraph once its last line is too far
  // above for any later line to join it (lines arrive by ascending baseline, and canJoin refuses a line more
  // than 1.6 leadings below).
  const byTag = new Map<string, Paragraph>();
  let open: Paragraph[] = [];
  const stillOpen = (p: Paragraph, baseline: number) => {
    const last = p.lines[p.lines.length - 1];
    const size = drawnSize(last.runs[0]);
    const lead = drawnLeading(last.runs[0]) || size * 1.2;
    return !(baseline - last.baseline > lead * 1.6);
  };
  for (const line of lines) {
    const lineTag = line.runs
      .flatMap((r) => r.markedContent ?? [])
      .find((tag) => tag.startsWith('GarnetTextBox'));
    let candidate: Paragraph | undefined;
    if (lineTag) candidate = byTag.get(lineTag);
    else {
      if (open.length > 64) open = open.filter((p) => stillOpen(p, line.baseline));
      for (let k = open.length - 1; k >= 0 && !candidate; k--)
        if (canJoin(open[k].lines[open[k].lines.length - 1], line)) candidate = open[k];
    }
    if (candidate) {
      // A line containing only Latin characters can still inherit the RTL
      // paragraph's punctuation order. The period is painted to the left of
      // TEST but belongs after it in logical text.
      if (lineTag && candidate.direction === 'rtl' && line.direction === 'ltr')
        line.text = logicalRTL(line.runs);
      candidate.lines.push(line);
      candidate.bbox = union(candidate.bbox, line.bbox);
      candidate.text +=
        /\s$/u.test(candidate.text) || /^\s/u.test(line.text) ? line.text : ` ${line.text}`;
      candidate.direction = firstStrong(candidate.text);
      candidate.alignment = classifyAlignment(candidate.lines, candidate.direction);
      candidate.leading =
        (line.baseline - candidate.lines[0].baseline) / (candidate.lines.length - 1);
      if (
        candidate.lines.length === 2 &&
        /^(?:[•◦▪‣*-]|\d+[.)])\s/u.test(candidate.lines[0].text)
      ) {
        const first = candidate.lines[0];
        const inset =
          candidate.direction === 'rtl'
            ? first.bbox[2] - line.bbox[2]
            : line.bbox[0] - first.bbox[0];
        if (inset > 0.5 && inset <= drawnSize(first.runs[0]) * 2) candidate.hangingIndent = inset;
      }
      candidate.invisible = candidate.invisible && line.runs.every((r) => r.renderMode === 3);
      if (line.runs.some((r) => model.fonts[r.fontKey]?.wmode === 1)) {
        candidate.readOnly = true;
        candidate.reason = 'Vertical CJK text is read-only.';
      } else if (line.runs.some((r) => r.renderMode >= 4 && r.renderMode <= 7)) {
        candidate.readOnly = true;
        candidate.reason = 'Clipping text is read-only.';
      }
      continue;
    }
    const dominant = dominantRun(line.runs);
    const vertical = line.runs.some((r) => model.fonts[r.fontKey]?.wmode === 1);
    const clipping = line.runs.some((r) => r.renderMode >= 4 && r.renderMode <= 7);
    const boxTag = lineTag;
    paragraphs.push({
      id: boxTag ?? `paragraph:${model.pageIndex}:${line.runs[0].id}`,
      bbox: [...line.bbox],
      layoutBBox: [...line.bbox],
      layoutToPage: [1, 0, 0, 1, 0, 0],
      lines: [line],
      direction: firstStrong(line.text),
      alignment: line.direction === 'rtl' ? 'right' : 'left',
      leading: drawnLeading(dominant) || drawnSize(dominant) * 1.2,
      dominantStyle: styleOfRun(dominant),
      text: line.text,
      readOnly: vertical || clipping,
      reason: vertical
        ? 'Vertical CJK text is read-only.'
        : clipping
          ? 'Clipping text is read-only.'
          : undefined,
      invisible: line.runs.every((r) => r.renderMode === 3),
      boxTag,
    });
    const created = paragraphs[paragraphs.length - 1];
    if (boxTag) byTag.set(boxTag, created);
    else open.push(created);
  }
  // The style of a paragraph is the one most of its letters have, over all its lines: the first line
  // can be a large bullet or capital standing alone.
  for (const paragraph of paragraphs)
    if (paragraph.lines.length > 1)
      paragraph.dominantStyle = styleOfRun(dominantRun(paragraph.lines.flatMap((l) => l.runs)));
  return paragraphs;
}

/** Detect in unrotated layout coordinates, then return visible page geometry. */
export function detectParagraphs(model: PageModel): Paragraph[] {
  const crop = model.cropBox;
  const userToLayout: Matrix = [1, 0, 0, -1, -crop[0], crop[3]];
  const layoutToPage = concat(invert(userToLayout), model.userToPage);
  const original = new Map(flattenObjects(model.objects).map((o) => [o.id, o]));
  const cloneObject = (o: PageObject): PageObject =>
    o.kind === 'form'
      ? {
          ...o,
          pageBBox: transformRect(o.bbox, userToLayout),
          children: o.children.map(cloneObject),
        }
      : { ...o, pageBBox: transformRect(o.bbox, userToLayout) };
  const layoutModel: PageModel = {
    ...model,
    userToPage: userToLayout,
    objects: model.objects.map(cloneObject),
  };
  return detectLayoutParagraphs(layoutModel).map((paragraph) => {
    const layoutBBox = [...paragraph.bbox] as Rect;
    const lines = paragraph.lines.map((line) => {
      const layoutBaseline = line.baseline;
      const layoutLineBBox = [...line.bbox] as Rect;
      const runs = line.runs.map((run) => original.get(run.id) as TextRun);
      const firstGlyph = runs.flatMap((run) => run.glyphs)[0];
      const baselinePoint = firstGlyph
        ? point(firstGlyph.origin, model.userToPage)
        : point([layoutLineBBox[0], layoutBaseline], layoutToPage);
      return {
        ...line,
        bbox: transformRect(layoutLineBBox, layoutToPage),
        baseline: baselinePoint[1],
        baselinePoint,
        layoutBaseline,
        layoutBBox: layoutLineBBox,
        runs,
      };
    });
    return {
      ...paragraph,
      bbox: transformRect(layoutBBox, layoutToPage),
      layoutBBox,
      layoutToPage,
      lines,
    };
  });
}
