import type { EditPage, Matrix, Point, Rect, SelectionItem } from '../../plugin-host/types';
import { bounds, contains, inverse, multiply, transformRect } from '../../plugin-host/geometry';

export type Alignment =
  'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom' | 'horizontal' | 'vertical';
export const units = { pt: 1, mm: 72 / 25.4, in: 72 };
/** The host uses unrotated top-left coordinates. The content package uses PDF default user coordinates. */
export function userToHost(page: EditPage, userToPage: Matrix): Matrix {
  return multiply(page.viewToPage, userToPage);
}
export function hostToUserMatrix(page: EditPage, userToPage: Matrix, m: Matrix): Matrix {
  const conversion = userToHost(page, userToPage);
  return multiply(inverse(conversion), multiply(m, conversion));
}
export function isBackground(box: Rect, page: EditPage): boolean {
  return box[0] <= 1 && box[1] <= 1 && box[2] >= page.width - 1 && box[3] >= page.height - 1;
}
export function hitObject(
  items: SelectionItem[],
  pt: Point,
  page: EditPage,
  scale: number,
  alt = false,
): SelectionItem | null {
  return (
    [...items].reverse().find((item) => {
      if (!alt && item.kind === 'path' && isBackground(item.bounds, page)) return false;
      const box = [
        ...((item.data as { hitBounds?: Rect } | undefined)?.hitBounds ?? item.bounds),
      ] as Rect;
      if (item.kind === 'path') {
        const margin = 4 / scale;
        if (box[2] - box[0] < margin) {
          box[0] -= margin;
          box[2] += margin;
        }
        if (box[3] - box[1] < margin) {
          box[1] -= margin;
          box[3] += margin;
        }
      }
      return contains(box, pt);
    }) ?? null
  );
}
export function about(box: Rect, degrees = 0, flip?: 'horizontal' | 'vertical'): Matrix {
  const x = (box[0] + box[2]) / 2,
    y = (box[1] + box[3]) / 2;
  const a = (degrees * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const sx = flip === 'horizontal' ? -1 : 1,
    sy = flip === 'vertical' ? -1 : 1;
  return [
    c * sx,
    s * sx,
    -s * sy,
    c * sy,
    x - c * sx * x + s * sy * y,
    y - s * sx * x - c * sy * y,
  ];
}
export function placement(width: number, height: number, page: Rect, point?: Point): Rect {
  const factor = Math.min(
    1,
    ((page[2] - page[0]) * 0.8) / width,
    ((page[3] - page[1]) * 0.8) / height,
  );
  const w = width * factor,
    h = height * factor;
  const x = point?.[0] ?? (page[0] + page[2] - w) / 2;
  const y = point?.[1] ?? (page[1] + page[3] - h) / 2;
  return [x, y, x + w, y + h];
}
export function alignment(
  items: SelectionItem[],
  mode: Alignment,
): { id: string; matrix: Matrix }[] {
  if (items.length < 2) return [];
  const box = bounds(items.map((item) => item.bounds));
  const axis = ['left', 'centre', 'right', 'horizontal'].includes(mode) ? 0 : 1;
  const distribute = mode === 'horizontal' || mode === 'vertical';
  const sorted = [...items].sort((a, b) => a.bounds[axis] - b.bounds[axis]);
  const total = sorted.reduce((sum, item) => sum + item.bounds[axis + 2] - item.bounds[axis], 0);
  const gap = (box[axis + 2] - box[axis] - total) / (items.length - 1);
  let cursor = box[axis];
  return sorted.map((item) => {
    const r = item.bounds;
    let delta: number;
    if (distribute) {
      delta = cursor - r[axis];
      cursor += r[axis + 2] - r[axis] + gap;
    } else if (mode === 'left' || mode === 'top') delta = box[axis] - r[axis];
    else if (mode === 'right' || mode === 'bottom') delta = box[axis + 2] - r[axis + 2];
    else delta = (box[axis] + box[axis + 2] - r[axis] - r[axis + 2]) / 2;
    return { id: item.id, matrix: [1, 0, 0, 1, axis === 0 ? delta : 0, axis === 1 ? delta : 0] };
  });
}
export function resized(box: Rect, width: number, height: number): Matrix {
  const sx = width / (box[2] - box[0]),
    sy = height / (box[3] - box[1]);
  return [sx, 0, 0, sy, box[0] * (1 - sx), box[1] * (1 - sy)];
}
export { bounds, inverse, multiply, transformRect };
