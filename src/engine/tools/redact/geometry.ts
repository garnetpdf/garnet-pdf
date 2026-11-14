import type { Quad, Rect } from '../../../shared/engine-api';

export function quadBounds(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function rectQuad(r: Rect): Quad {
  return [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]];
}

export function normalizeRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export function intersects(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function insideRect(x: number, y: number, r: Rect, tolerance = 0): boolean {
  return x >= r[0] - tolerance && x <= r[2] + tolerance && y >= r[1] - tolerance && y <= r[3] + tolerance;
}

/** True when point lies inside the convex quad (MuPDF order ul, ur, ll, lr). */
export function insideQuad(x: number, y: number, q: Quad): boolean {
  const poly: [number, number][] = [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % 4];
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function quadCenter(q: Quad): [number, number] {
  return [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
}

/** Merges the character quads of one line into one quad along the line direction. */
export function mergeLineQuads(quads: Quad[], direction: [number, number]): Quad {
  if (quads.length === 1) return quads[0];
  const [dx, dy] = Math.hypot(direction[0], direction[1]) > 0 ? direction : [1, 0];
  const project = (q: Quad) => ((q[0] + q[4]) / 2) * dx + ((q[1] + q[5]) / 2) * dy;
  const sorted = [...quads].sort((a, b) => project(a) - project(b));
  const first = sorted[0], last = sorted.at(-1)!;
  return [first[0], first[1], last[2], last[3], first[4], first[5], last[6], last[7]];
}
