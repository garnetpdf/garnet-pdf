/**
 * Coordinate helpers for annotation overlays.
 * Engine annotation geometry is in MuPDF page space ("P": rotation applied, top-left origin), the same
 * space as the page canvas. Tool points from the host are unrotated user space ("U"); page.pageToView
 * maps U to P. Overlays position elements with percentages of the P-space page size, so they need no
 * zoom factor and follow the CSS view rotation of the page container automatically.
 */
import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import type { PageInfo } from '../../../../shared/engine-api';
import type { EditPage, Point, Rect } from '../../../plugin-host/types';
import {
  inverse,
  transformPoint,
  transformRect,
  viewMatrix,
  viewPointToPage,
} from '../../../plugin-host/geometry';

export function pageSize(page: EditPage): [number, number] {
  const r = transformRect(page.pageToView, [0, 0, page.width, page.height]);
  return [r[2] - r[0], r[3] - r[1]];
}

export function uToP(page: EditPage, u: Point): Point {
  return transformPoint(page.pageToView, u);
}

export function pToU(page: EditPage, p: Point): Point {
  return transformPoint(page.viewToPage, p);
}

export function pRectToU(page: EditPage, r: Rect): Rect {
  return transformRect(page.viewToPage, r);
}

/** Pointer position in P space for an element that covers the whole page (inset: 0). */
export function eventToP(
  page: EditPage,
  event: { clientX: number; clientY: number },
  element: HTMLElement,
): Point {
  const box = element.getBoundingClientRect();
  const [pw] = pageSize(page);
  const scale = element.offsetWidth / pw || 1;
  const u = viewPointToPage(page, [(event.clientX - box.left) / scale, (event.clientY - box.top) / scale]);
  return uToP(page, u);
}

export function pctRect(page: EditPage, r: Rect): CSSProperties {
  const [pw, ph] = pageSize(page);
  return {
    left: `${(Math.min(r[0], r[2]) / pw) * 100}%`,
    top: `${(Math.min(r[1], r[3]) / ph) * 100}%`,
    width: `${(Math.abs(r[2] - r[0]) / pw) * 100}%`,
    height: `${(Math.abs(r[3] - r[1]) / ph) * 100}%`,
  };
}

export function pctPoint(page: EditPage, p: Point): CSSProperties {
  const [pw, ph] = pageSize(page);
  return { left: `${(p[0] / pw) * 100}%`, top: `${(p[1] / ph) * 100}%` };
}

/** CSS pixels per PDF point for an overlay element covering the page. */
export function usePageScale(ref: RefObject<HTMLElement | null>, page: EditPage): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(el.offsetWidth / pageSize(page)[0] || 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, page]);
  return scale;
}

/** The same page model PageView builds, for code that only has the document's page list. */
export function pageModel(docId: string, info: PageInfo): EditPage {
  const rotated = info.rotation % 180 !== 0;
  const width = rotated ? info.height : info.width;
  const height = rotated ? info.width : info.height;
  const matrix = viewMatrix(width, height, info.rotation);
  return {
    docId,
    pageId: info.id,
    width,
    height,
    rotation: info.rotation,
    pageToView: matrix,
    viewToPage: inverse(matrix),
  };
}

export function rectOf(points: Point[]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function quadContains(q: number[], p: Point): boolean {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return (
    p[0] >= Math.min(...xs) && p[0] <= Math.max(...xs) && p[1] >= Math.min(...ys) && p[1] <= Math.max(...ys)
  );
}
