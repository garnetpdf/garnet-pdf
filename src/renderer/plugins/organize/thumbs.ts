/**
 * Thumbnails for the Organize grid, cached by page content fingerprint: moving, reordering or
 * undoing pages never re-renders them, only pages whose content, rotation or boxes changed.
 */
import { BitmapCache } from '../../viewer/render-cache';
import type { PageId } from '../../../shared/engine-api';
import { pageContext } from './pageActions';
import { useOrganize } from './state';

const cache = new BitmapCache(160 * 1024 * 1024);
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function slot(signal: AbortSignal): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const go = () => {
      signal.removeEventListener('abort', stop);
      inFlight++;
      resolve();
    };
    const stop = () => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    waiting.push(go);
    signal.addEventListener('abort', stop, { once: true });
  });
}
function release(): void {
  inFlight--;
  waiting.shift()?.();
}

/** Thumbnail box in CSS pixels for a tile width; pages fit inside it. */
export function thumbBox(width: number): { w: number; h: number } {
  return { w: width, h: Math.round(width * 1.3) };
}

/** Render width buckets, so small size changes reuse bitmaps (CSS scales them). */
export function bucketFor(width: number, dpr: number): number {
  return Math.min(1280, Math.ceil((width * dpr) / 64) * 64);
}

export function thumbKey(docId: string, fingerprint: string, bucket: number): string {
  return `${docId}:${fingerprint}:${bucket}`;
}

export function cachedThumb(key: string): ImageBitmap | undefined {
  return cache.get(key);
}

export async function renderThumb(
  docId: string,
  pageId: PageId,
  size: { width: number; height: number },
  bucket: number,
  key: string,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  await slot(signal);
  try {
    if (signal.aborted) return null;
    const hit = cache.get(key);
    if (hit) return hit;
    const box = thumbBox(bucket);
    const scale = Math.min(box.w / size.width, box.h / size.height);
    useOrganize.getState().countRender();
    const result = await pageContext().engine.call(
      'core.render',
      { docId, pageId, scale, dpr: 1, annots: true, forms: true },
      { signal, priority: 1 },
    );
    let bitmap = result.bitmap ?? null;
    if (!bitmap && result.pixels) bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height));
    if (!bitmap) return null;
    if (signal.aborted) {
      bitmap.close();
      return null;
    }
    cache.set(key, bitmap);
    return bitmap;
  } finally {
    release();
  }
}

export function clearThumbs(): void {
  cache.clear();
}
