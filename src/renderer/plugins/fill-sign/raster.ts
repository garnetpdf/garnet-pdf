/**
 * Turns drawn strokes, typed names and imported pictures into trimmed PNG images with transparency,
 * for signatures, initials and image stamps. Canvas code only, behind a small factory so the same
 * functions run in the app (HTML canvas) and in unit tests (a Node canvas).
 */
import { strokeWidths, type PressurePoint } from '../comment/shared/smoothing';

export interface RasterSurface {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
}
export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
}
export interface RasterFactory {
  create(width: number, height: number): RasterSurface;
  encodePng(surface: RasterSurface): Promise<ArrayBuffer>;
  decode(bytes: ArrayBuffer): Promise<DecodedImage>;
}
export interface RasterImage {
  png: ArrayBuffer;
  /** Pixel size of the PNG. */
  width: number;
  height: number;
}
export type RGB = [number, number, number];

const MAX_SIDE = 2400;
const css = (c: RGB) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;

function context(surface: RasterSurface): CanvasRenderingContext2D {
  const ctx = surface.getContext('2d');
  if (!ctx) throw new Error('Drawing is not available.');
  return ctx;
}

/** Bounding box of pixels with visible alpha, or null when the surface is empty. */
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number, threshold = 10) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Crops transparent margins (keeping `pad` pixels) and encodes the result as PNG. */
export async function trimToPng(factory: RasterFactory, surface: RasterSurface, pad = 4): Promise<RasterImage> {
  const ctx = context(surface);
  const data = ctx.getImageData(0, 0, surface.width, surface.height);
  const box = alphaBounds(data.data, surface.width, surface.height);
  if (!box) throw new Error('There is nothing to use. Draw, type or choose a picture first.');
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const width = Math.min(surface.width - x, box.width + pad * 2);
  const height = Math.min(surface.height - y, box.height + pad * 2);
  const out = factory.create(width, height);
  context(out).putImageData(ctx.getImageData(x, y, width, height), 0, 0);
  return { png: await factory.encodePng(out), width, height };
}

export interface StrokeInput {
  points: PressurePoint[];
}

/**
 * Renders strokes drawn on a pad (coordinates in pad pixels) with pressure or speed based width and
 * curves through the midpoints, at `scale` times the pad resolution.
 */
export async function renderStrokes(
  factory: RasterFactory,
  strokes: StrokeInput[],
  options: { width: number; height: number; color: RGB; penWidth: number; scale?: number },
): Promise<RasterImage> {
  const usable = strokes.filter((s) => s.points.length);
  if (!usable.length) throw new Error('Draw your signature first.');
  const scale = Math.min(options.scale ?? 2, MAX_SIDE / Math.max(options.width, options.height));
  const surface = factory.create(Math.ceil(options.width * scale), Math.ceil(options.height * scale));
  const ctx = context(surface);
  ctx.strokeStyle = css(options.color);
  ctx.fillStyle = css(options.color);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of usable) {
    const pts = stroke.points;
    const widths = strokeWidths(pts, options.penWidth);
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * scale, pts[0].y * scale, (widths[0] * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const mid = (a: PressurePoint, b: PressurePoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let from = { x: pts[0].x, y: pts[0].y };
    for (let i = 1; i < pts.length; i++) {
      const control = pts[i - 1];
      const to = i === pts.length - 1 ? pts[i] : mid(pts[i - 1], pts[i]);
      ctx.beginPath();
      ctx.lineWidth = ((widths[i - 1] + widths[i]) / 2) * scale;
      ctx.moveTo(from.x * scale, from.y * scale);
      if (i === 1) ctx.lineTo(to.x * scale, to.y * scale);
      else ctx.quadraticCurveTo(control.x * scale, control.y * scale, to.x * scale, to.y * scale);
      ctx.stroke();
      from = to;
    }
  }
  return trimToPng(factory, surface, Math.ceil(options.penWidth * scale));
}

export const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;

/** Renders a typed name in a script font (the font must already be loaded). */
export async function renderTyped(
  factory: RasterFactory,
  text: string,
  options: { family: string; weight?: string; size?: number; color: RGB },
): Promise<RasterImage> {
  const value = text.trim();
  if (!value) throw new Error('Type your name first.');
  const size = options.size ?? 96;
  const font = `${options.weight ?? '400'} ${size}px "${options.family}"`;
  const direction: CanvasDirection = ARABIC.test(value) ? 'rtl' : 'ltr';
  const probe = context(factory.create(8, 8));
  probe.font = font;
  probe.direction = direction;
  probe.textAlign = 'left';
  const metrics = probe.measureText(value);
  const left = Math.ceil(metrics.actualBoundingBoxLeft || 0);
  const right = Math.ceil(metrics.actualBoundingBoxRight || metrics.width);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || size);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || size * 0.3);
  const pad = Math.ceil(size * 0.25);
  const width = Math.min(MAX_SIDE, left + right + pad * 2);
  const height = Math.min(MAX_SIDE, ascent + descent + pad * 2);
  const surface = factory.create(width, height);
  const ctx = context(surface);
  ctx.font = font;
  ctx.fillStyle = css(options.color);
  ctx.textBaseline = 'alphabetic';
  ctx.direction = direction;
  ctx.textAlign = 'left';
  ctx.fillText(value, pad + left, pad + ascent);
  return trimToPng(factory, surface, 4);
}

/**
 * Prepares an imported picture: scales it down, optionally turns a white or near-white background
 * transparent (soft edge so ink keeps its anti-aliasing), and trims the margins.
 */
export async function prepareImage(
  factory: RasterFactory,
  bytes: ArrayBuffer,
  options: { removeWhite: boolean; maxSide?: number },
): Promise<RasterImage> {
  let decoded: DecodedImage;
  try {
    decoded = await factory.decode(bytes);
  } catch {
    throw new Error('This picture could not be read. Use a PNG or JPEG file.');
  }
  if (!decoded.width || !decoded.height) throw new Error('This picture is empty.');
  const limit = Math.min(options.maxSide ?? 1600, MAX_SIDE);
  const ratio = Math.min(1, limit / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * ratio));
  const height = Math.max(1, Math.round(decoded.height * ratio));
  const surface = factory.create(width, height);
  const ctx = context(surface);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(decoded.source, 0, 0, width, height);
  if (options.removeWhite) {
    const image = ctx.getImageData(0, 0, width, height);
    whiteToTransparent(image.data);
    ctx.putImageData(image, 0, 0);
  }
  return trimToPng(factory, surface, 2);
}

/** Near-white pixels become transparent with a soft ramp between `low` and `high` luminance. */
export function whiteToTransparent(data: Uint8ClampedArray, low = 165, high = 232) {
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (luminance >= high) data[i + 3] = 0;
    else if (luminance > low) data[i + 3] = Math.round(data[i + 3] * ((high - luminance) / (high - low)));
  }
}

/**
 * Characters the PDF standard fonts used for text box and form appearances cannot draw (for example
 * Arabic). Such text is added as a picture of the text so it shows in every PDF reader.
 */
export const NEEDS_PICTURE = /[^\t\n\r\u0020-\u024f\u02b0-\u036f\u1e00-\u1eff\u2000-\u206f\u20a0-\u20bf\u2100-\u214f]/;

/** Renders typed lines (each line in its own direction) at `scale` pixels per point. */
export async function renderTextBlock(
  factory: RasterFactory,
  text: string,
  options: { fontSize: number; color: RGB; family: string; scale?: number },
): Promise<RasterImage & { pointWidth: number; pointHeight: number }> {
  const scale = options.scale ?? 4;
  const size = options.fontSize * scale;
  const lineHeight = Math.ceil(size * 1.3);
  const pad = Math.ceil(size * 0.25);
  const lines = text.split('\n');
  const font = `${size}px ${options.family}`;
  const probe = context(factory.create(8, 8));
  probe.font = font;
  const widths = lines.map((line) => Math.ceil(probe.measureText(line || ' ').width));
  const width = Math.min(MAX_SIDE * 2, Math.max(...widths) + pad * 2);
  const height = Math.min(MAX_SIDE * 2, lines.length * lineHeight + pad * 2);
  const surface = factory.create(width, height);
  const ctx = context(surface);
  ctx.font = font;
  ctx.fillStyle = css(options.color);
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    const rtl = ARABIC.test(line);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    ctx.fillText(line, rtl ? width - pad : pad, pad + i * lineHeight + lineHeight / 2);
  });
  return { png: await factory.encodePng(surface), width, height, pointWidth: width / scale, pointHeight: height / scale };
}
