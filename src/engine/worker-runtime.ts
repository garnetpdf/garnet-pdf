import { EngineContext } from './context';
import type { Handler, RenderResult } from './ops/core';
import { PriorityQueue } from './scheduler';
import * as mupdf from 'mupdf';

const diagnostics: string[] = [];
mupdf.setLog({
  error(message) { diagnostics.push(message); },
  warning(message) { diagnostics.push(message); },
});

interface OpModule { ops: Record<string, Handler> }
const modules = import.meta.glob<OpModule>('./ops/*.ts', { eager: true });
const operations = new Map<string, OpModule['ops'][string]>();
for (const module of Object.values(modules)) {
  for (const [method, handler] of Object.entries(module.ops)) {
    if (operations.has(method)) throw new Error(`Duplicate engine operation: ${method}`);
    operations.set(method, handler);
  }
}

interface Call { id: number; method: string; args: unknown; priority: number }
const context = new EngineContext();
const queue = new PriorityQueue<Call>();
const cancelled = new Set<number>();
let busy = false;
const scope = self as DedicatedWorkerGlobalScope;
const renderCache = new Map<string, { pixels: Uint8ClampedArray; width: number; height: number }>();
let cacheBytes = 0;

function cacheKey(args: unknown) {
  const request = args as { docId: string; pageId: number; scale: number; dpr?: number; rect?: unknown; annots?: boolean; forms?: boolean };
  const revision = context.get(request.docId).revision;
  return JSON.stringify([request.docId, revision, request.pageId, Math.round(request.scale * 1000) / 1000, request.dpr ?? 1, request.annots !== false, request.forms !== false, request.rect]);
}

function remember(key: string, result: RenderResult) {
  if (!result.pixels) return;
  const pixels = new Uint8ClampedArray(result.pixels);
  renderCache.set(key, { pixels, width: result.width, height: result.height });
  cacheBytes += pixels.byteLength;
  while (cacheBytes > 128 * 1024 * 1024 && renderCache.size) {
    const first = renderCache.keys().next().value;
    if (first === undefined) break;
    const entry = renderCache.get(first)!;
    cacheBytes -= entry.pixels.byteLength;
    renderCache.delete(first);
  }
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as ({ type: 'call' } & Call) | { type: 'cancel'; id: number };
  if (message.type === 'cancel') { cancelled.add(message.id); return; }
  queue.push(message);
  void runNext();
};
scope.postMessage({ type: 'ready' });

async function runNext() {
  if (busy) return;
  const call = queue.shift();
  if (!call) return;
  busy = true;
  try {
    diagnostics.length = 0;
    if (cancelled.has(call.id)) throw new Error('CANCELLED');
    const handler = operations.get(call.method);
    if (!handler) throw new Error(`Unknown engine operation: ${call.method}`);
    const key = call.method === 'core.render' && (call.args as { cache?: boolean }).cache !== false ? cacheKey(call.args) : undefined;
    const cached = key ? renderCache.get(key) : undefined;
    if (cached && key) {
      renderCache.delete(key); renderCache.set(key, cached);
    }
    const result = cached ? { pixels: new Uint8ClampedArray(cached.pixels), width: cached.width, height: cached.height, elapsedMs: 0 } : await handler(context, call.args as never, {
      cancelled: () => cancelled.has(call.id),
      progress: (data: unknown) => scope.postMessage({ id: call.id, type: 'progress', data }),
      yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    });
    if (call.method === 'core.open' && result && typeof result === 'object' && diagnostics.length) {
      (result as { diagnostics?: string[] }).diagnostics = [...diagnostics];
    }
    if (key && !cached) remember(key, result as RenderResult);
    if (cancelled.has(call.id)) throw new Error('CANCELLED');
    const transfers: Transferable[] = [];
    if (call.method === 'core.render') {
      const render = result as RenderResult;
      if (render.pixels && typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(render.pixels), render.width, render.height));
        render.bitmap = bitmap;
        delete render.pixels;
        transfers.push(bitmap);
      } else if (render.pixels) transfers.push(render.pixels.buffer);
    }
    if ((call.method === 'core.save' || call.method === 'core.snapshot') && result && typeof result === 'object' && 'bytes' in result) {
      transfers.push((result as { bytes: ArrayBuffer }).bytes);
    }
    if (cancelled.has(call.id) && (call.method === 'core.render' || call.method === 'core.search')) {
      if (result && typeof result === 'object' && 'bitmap' in result) (result as { bitmap?: ImageBitmap }).bitmap?.close();
      throw new Error('CANCELLED');
    }
    scope.postMessage({ id: call.id, ok: true, result }, transfers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id: call.id, ok: false, error: diagnostics.length ? `${message} (${diagnostics.join('; ')})` : message });
  } finally {
    cancelled.delete(call.id);
    busy = false;
    void runNext();
  }
}
