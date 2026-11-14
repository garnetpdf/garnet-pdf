/**
 * Zoom levels that the mouse wheel, the plus and minus buttons and Ctrl+= / Ctrl+- step through (1 = 100%).
 * Stepping by a factor left the zoom on values such as 96% or 122% and never back on 100%.
 */
export const ZOOM_STEPS = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 12,
  16, 24, 32, 48, 64,
];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * The next level above (`direction` 1) or below (-1) the current zoom. A zoom between two levels, such as
 * "fit width" at 123%, goes to the nearest level in that direction (125% up, 110% down).
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const slack = Math.abs(current) * 0.001;
  if (direction > 0) return ZOOM_STEPS.find((level) => level > current + slack) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--)
    if (ZOOM_STEPS[i] < current - slack) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}
