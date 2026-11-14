/** Stroke smoothing for ink comments and drawn signatures (pure functions, unit-tested). */
export type Pt = [number, number];
export interface PressurePoint {
  x: number;
  y: number;
  /** 0..1; mice report 0.5 while a button is down. */
  pressure: number;
  /** Milliseconds. */
  time: number;
}

/** Drops points closer than `minDistance` to the previous kept point (always keeps the last one). */
export function dedupe(points: Pt[], minDistance = 0.4): Pt[] {
  if (points.length < 3) return points.slice();
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minDistance) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Ramer-Douglas-Peucker simplification. */
export function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let index = -1;
    let max = tolerance;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / length;
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index > 0) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting; keeps both end points. */
export function chaikin(points: Pt[], iterations = 2): Pt[] {
  let current = points;
  for (let k = 0; k < iterations && current.length > 2; k++) {
    const next: Pt[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const [x0, y0] = current[i];
      const [x1, y1] = current[i + 1];
      next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** Smooths a raw pointer path for an ink annotation (PDF draws ink as straight segments). */
export function smoothStroke(points: Pt[], tolerance = 0.35): Pt[] {
  if (points.length < 3) return points.slice();
  return chaikin(simplify(dedupe(points, tolerance), tolerance), 2).map(
    (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100] as Pt,
  );
}

/**
 * Stroke width for each point: pen pressure when the device reports it, otherwise a gentle
 * speed-based variation (faster = thinner), both smoothed so the line does not flicker.
 */
export function strokeWidths(points: PressurePoint[], base: number): number[] {
  const usesPressure = points.some((p) => p.pressure > 0 && Math.abs(p.pressure - 0.5) > 0.01);
  const widths: number[] = [];
  let previous = base;
  for (let i = 0; i < points.length; i++) {
    let target: number;
    if (usesPressure) target = base * (0.35 + 0.95 * Math.min(1, Math.max(0, points[i].pressure)));
    else if (i === 0) target = base;
    else {
      const a = points[i - 1];
      const b = points[i];
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, b.time - a.time);
      target = base * Math.min(1.25, Math.max(0.55, 1.3 - speed * 0.35));
    }
    previous = i === 0 ? target : previous * 0.7 + target * 0.3;
    widths.push(previous);
  }
  return widths;
}

/** Mean pressure of pen input (1 when the device does not report pressure). */
export function meanPressure(points: PressurePoint[]): number {
  const real = points.filter((p) => p.pressure > 0 && Math.abs(p.pressure - 0.5) > 0.01);
  if (!real.length) return 0.5;
  return real.reduce((sum, p) => sum + p.pressure, 0) / real.length;
}
