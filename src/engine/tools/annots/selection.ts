/**
 * Text selection between two page-space points over MuPDF structured text (`core.text` lines).
 * Pure TypeScript, shared by the Comment tools (renderer) and the unit tests.
 *
 * The selection is visual and direction-aware: lines are grouped into rows along the reading
 * direction of the line under the pointer, characters are ordered along that direction, and for
 * a row whose characters are mostly right-to-left (odd bidi level) the start/end of the row are
 * swapped. Dragging across Arabic therefore highlights exactly the glyphs between the pointer
 * positions, while the returned text stays in MuPDF's logical order.
 */
import type { Quad, TextLine } from '../../../shared/engine-api';
import type { Point } from './types';

export interface TextSelection {
  quads: Quad[];
  text: string;
  /** Number of characters selected. */
  count: number;
}

interface Glyph {
  c: string;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  order: number;
  rtl: boolean;
}
interface Row {
  v0: number;
  v1: number;
  glyphs: Glyph[];
  rtl: boolean;
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];

function frameOf(lines: TextLine[], p: Point): { d: Point; n: Point } {
  let best: TextLine | undefined;
  let bestDistance = Infinity;
  for (const line of lines) {
    if (!line.chars.length) continue;
    const [x0, y0, x1, y1] = line.bbox;
    const dx = p[0] < x0 ? x0 - p[0] : p[0] > x1 ? p[0] - x1 : 0;
    const dy = p[1] < y0 ? y0 - p[1] : p[1] > y1 ? p[1] - y1 : 0;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = line;
    }
  }
  const raw = best?.direction ?? [1, 0];
  const length = Math.hypot(raw[0], raw[1]) || 1;
  const d: Point = [raw[0] / length, raw[1] / length];
  return { d, n: [-d[1], d[0]] };
}

function buildRows(lines: TextLine[], d: Point, n: Point): Row[] {
  const glyphs: Glyph[] = [];
  let order = 0;
  for (const line of lines) {
    const ld = Math.hypot(line.direction[0], line.direction[1]) || 1;
    // Only lines running in (roughly) the same direction take part.
    if ((line.direction[0] * d[0] + line.direction[1] * d[1]) / ld < 0.9) {
      order += line.chars.length;
      continue;
    }
    for (const ch of line.chars) {
      const q = ch.quad;
      const corners: Point[] = [
        [q[0], q[1]],
        [q[2], q[3]],
        [q[4], q[5]],
        [q[6], q[7]],
      ];
      const us = corners.map((c) => dot(c, d));
      const vs = corners.map((c) => dot(c, n));
      glyphs.push({
        c: ch.c,
        u0: Math.min(...us),
        u1: Math.max(...us),
        v0: Math.min(...vs),
        v1: Math.max(...vs),
        order: order++,
        rtl: ch.bidi % 2 === 1,
      });
    }
  }
  glyphs.sort((a, b) => (a.v0 + a.v1) / 2 - (b.v0 + b.v1) / 2);
  const rows: Row[] = [];
  for (const g of glyphs) {
    const height = g.v1 - g.v0;
    const mid = (g.v0 + g.v1) / 2;
    const row = rows.find((r) => {
      const overlap = Math.min(r.v1, g.v1) - Math.max(r.v0, g.v0);
      return overlap > 0.5 * Math.min(height || 1, r.v1 - r.v0 || 1) || (mid > r.v0 && mid < r.v1);
    });
    if (row) {
      row.glyphs.push(g);
      row.v0 = Math.min(row.v0, g.v0);
      row.v1 = Math.max(row.v1, g.v1);
    } else rows.push({ v0: g.v0, v1: g.v1, glyphs: [g], rtl: false });
  }
  for (const row of rows) {
    row.glyphs.sort((a, b) => a.u0 + a.u1 - (b.u0 + b.u1));
    const strong = row.glyphs.filter((g) => g.c.trim());
    row.rtl = strong.filter((g) => g.rtl).length > strong.length / 2;
  }
  rows.sort((a, b) => a.v0 + a.v1 - (b.v0 + b.v1));
  return rows;
}

function rowIndexAt(rows: Row[], v: number): number {
  let best = 0;
  let bestDistance = Infinity;
  rows.forEach((row, i) => {
    const distance = v < row.v0 ? row.v0 - v : v > row.v1 ? v - row.v1 : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return best;
}

export function selectText(lines: TextLine[], from: Point, to: Point): TextSelection {
  const empty: TextSelection = { quads: [], text: '', count: 0 };
  if (!lines.some((l) => l.chars.length)) return empty;
  const { d, n } = frameOf(lines, from);
  const rows = buildRows(lines, d, n);
  if (!rows.length) return empty;
  let a = { u: dot(from, d), r: rowIndexAt(rows, dot(from, n)) };
  let b = { u: dot(to, d), r: rowIndexAt(rows, dot(to, n)) };
  if (b.r < a.r) [a, b] = [b, a];
  const selected: { row: Row; glyphs: Glyph[] }[] = [];
  for (let r = a.r; r <= b.r; r++) {
    const row = rows[r];
    const mid = (g: Glyph) => (g.u0 + g.u1) / 2;
    let pick: (g: Glyph) => boolean;
    if (a.r === b.r) {
      const lo = Math.min(a.u, b.u);
      const hi = Math.max(a.u, b.u);
      pick = (g) => mid(g) >= lo && mid(g) <= hi;
    } else if (r === a.r) pick = row.rtl ? (g) => mid(g) <= a.u : (g) => mid(g) >= a.u;
    else if (r === b.r) pick = row.rtl ? (g) => mid(g) >= b.u : (g) => mid(g) <= b.u;
    else pick = () => true;
    const glyphs = row.glyphs.filter(pick);
    if (glyphs.length) selected.push({ row, glyphs });
  }
  const quads: Quad[] = [];
  const pieces: string[] = [];
  let count = 0;
  for (const { row, glyphs } of selected) {
    // One quad per contiguous run in visual order; runs break at large gaps (columns).
    const runs: Glyph[][] = [];
    const height = row.v1 - row.v0;
    for (const g of glyphs) {
      const run = runs.at(-1);
      const previous = run?.at(-1);
      if (run && previous && g.u0 - previous.u1 < height * 1.5) run.push(g);
      else runs.push([g]);
    }
    for (const run of runs) {
      const u0 = Math.min(...run.map((g) => g.u0));
      const u1 = Math.max(...run.map((g) => g.u1));
      const v0 = Math.min(...run.map((g) => g.v0));
      const v1 = Math.max(...run.map((g) => g.v1));
      const at = (u: number, v: number): Point => [u * d[0] + v * n[0], u * d[1] + v * n[1]];
      const ul = at(u0, v0);
      const ur = at(u1, v0);
      const ll = at(u0, v1);
      const lr = at(u1, v1);
      quads.push([ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]]);
    }
    count += glyphs.length;
    pieces.push(
      [...glyphs]
        .sort((x, y) => x.order - y.order)
        .map((g) => g.c)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return { quads, text: pieces.filter(Boolean).join('\n'), count };
}
