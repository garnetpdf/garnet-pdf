import type { Matrix, Point, Rect } from './types.js';
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** Apply a, then b, in PDF row-vector convention. */
export function concat(a: Matrix, b: Matrix): Matrix {
    return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}
export function invert(m: Matrix): Matrix {
    const d = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-12)
        throw new Error('Singular matrix');
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export function point(p: Point, m: Matrix): Point { return [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]]; }
export function bounds(points: Point[]): Rect {
    if (!points.length)
        return [0, 0, 0, 0];
    return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}
export function transformRect(r: Rect, m: Matrix): Rect { return bounds([[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]].map(p => point(p as Point, m))); }
export function union(a: Rect, b: Rect): Rect { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }
export function intersect(a: Rect, b: Rect): Rect { const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]); return [x, y, Math.max(x, Math.min(a[2], b[2])), Math.max(y, Math.min(a[3], b[3]))]; }
export function expand(r: Rect, by: number): Rect { return [r[0] - by, r[1] - by, r[2] + by, r[3] + by]; }
export function translate(x: number, y: number): Matrix { return [1, 0, 0, 1, x, y]; }
