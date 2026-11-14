import type { EditPage, Matrix, Point, Rect } from './types';
export const identity: Matrix = [1, 0, 0, 1, 0, 0];
export function transformPoint(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}
export function inverse(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(d) < 1e-12) throw new Error('Singular transform');
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
}
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function transformRect(m: Matrix, r: Rect): Rect {
  const points = [
    transformPoint(m, [r[0], r[1]]),
    transformPoint(m, [r[2], r[1]]),
    transformPoint(m, [r[2], r[3]]),
    transformPoint(m, [r[0], r[3]]),
  ];
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}
export function bounds(rects: Rect[]): Rect {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}
export function contains(r: Rect, p: Point): boolean {
  return p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
}
export function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function viewMatrix(width: number, height: number, rotation: number): Matrix {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, height, 0];
    case 180:
      return [-1, 0, 0, -1, width, height];
    case 270:
      return [0, -1, 1, 0, 0, width];
    default:
      return [...identity];
  }
}
export function snapMove(
  box: Rect,
  delta: Point,
  targets: Rect[],
  page: Rect,
  tolerance: number,
): { matrix: Matrix; guides: { axis: 'x' | 'y'; value: number }[] } {
  const guides: { axis: 'x' | 'y'; value: number }[] = [];
  const move = [...delta];
  for (const axis of [0, 1] as const) {
    const edges = [box[axis], (box[axis] + box[axis + 2]) / 2, box[axis + 2]];
    const values = [page, ...targets].flatMap((r) => [
      r[axis],
      (r[axis] + r[axis + 2]) / 2,
      r[axis + 2],
    ]);
    let best = tolerance + 1,
      bestValue = 0,
      adjust = 0;
    for (const e of edges)
      for (const v of values) {
        const diff = v - (e + delta[axis]);
        if (Math.abs(diff) < best) {
          best = Math.abs(diff);
          bestValue = v;
          adjust = diff;
        }
      }
    if (best <= tolerance) {
      move[axis] += adjust;
      guides.push({ axis: axis === 0 ? 'x' : 'y', value: bestValue });
    }
  }
  return { matrix: [1, 0, 0, 1, move[0], move[1]], guides };
}
export function resizeMatrix(box: Rect, handle: string, point: Point, aspect: boolean): Matrix {
  const ax = handle.includes('w') ? box[2] : box[0],
    ay = handle.includes('n') ? box[3] : box[1];
  let sx =
    handle === 'n' || handle === 's'
      ? 1
      : (point[0] - ax) / ((handle.includes('w') ? box[0] : box[2]) - ax || 1);
  let sy =
    handle === 'e' || handle === 'w'
      ? 1
      : (point[1] - ay) / ((handle.includes('n') ? box[1] : box[3]) - ay || 1);
  sx = Math.max(0.02, sx);
  sy = Math.max(0.02, sy);
  if (aspect && handle.length === 2) {
    const scale = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    sx = sy = scale;
  }
  return [sx, 0, 0, sy, ax * (1 - sx), ay * (1 - sy)];
}
export function rotationMatrix(box: Rect, start: Point, end: Point, snap = false): Matrix {
  const cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  let a = Math.atan2(end[1] - cy, end[0] - cx) - Math.atan2(start[1] - cy, start[0] - cx);
  if (snap) a = (Math.round(a / (Math.PI / 12)) * Math.PI) / 12;
  const c = Math.cos(a),
    s = Math.sin(a);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

/** Includes the CSS-only view rotation in pointer and keyboard mapping. */
export function fullViewMatrix(page: EditPage): Matrix {
  const b = transformRect(page.pageToView, [0, 0, page.width, page.height]);
  return multiply(viewMatrix(b[2] - b[0], b[3] - b[1], page.viewRotation || 0), page.pageToView);
}
export function viewPointToPage(page: EditPage, point: Point): Point {
  return transformPoint(inverse(fullViewMatrix(page)), point);
}
export function viewDeltaToPage(page: EditPage, delta: Point): Point {
  const m = inverse(fullViewMatrix(page)),
    a = transformPoint(m, [0, 0]),
    b = transformPoint(m, delta);
  return [b[0] - a[0], b[1] - a[1]];
}
export function userHandle(page: EditPage, box: Rect, handle: string): string {
  const b = transformRect(page.pageToView, box),
    p: Point = [
      handle.includes('w') ? b[0] : handle.includes('e') ? b[2] : (b[0] + b[2]) / 2,
      handle.includes('n') ? b[1] : handle.includes('s') ? b[3] : (b[1] + b[3]) / 2,
    ];
  const raw = transformPoint(page.viewToPage, p),
    epsilon = 0.01;
  const x =
    Math.abs(raw[0] - box[0]) < epsilon ? 'w' : Math.abs(raw[0] - box[2]) < epsilon ? 'e' : '';
  const y =
    Math.abs(raw[1] - box[1]) < epsilon ? 'n' : Math.abs(raw[1] - box[3]) < epsilon ? 's' : '';
  return y + x;
}
