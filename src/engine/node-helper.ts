/** The Node tests use the exact operation implementations used by the worker. */
import { EngineContext } from './context';
import type { Handler } from './ops/core';
import type { EngineOps, EngineCallOptions } from '../shared/engine-api';

const modules = import.meta.glob<{ ops: Record<string, Handler> }>('./ops/*.ts', { eager: true });
const all = new Map<string, Handler>();
for (const module of Object.values(modules)) {
  for (const [method, handler] of Object.entries(module.ops)) {
    if (all.has(method)) throw new Error(`Duplicate engine operation: ${method}`);
    all.set(method, handler);
  }
}
const immediate = { cancelled: () => false, progress: (_data: unknown) => {}, yield: async () => {} };

export function createNodeEngine() {
  const context = new EngineContext();
  return {
    context,
    async call<K extends keyof EngineOps>(method: K, args: EngineOps[K]['args'], options?: EngineCallOptions): Promise<EngineOps[K]['result']> {
      const handler = all.get(String(method));
      if (!handler) throw new Error(`Unknown engine operation: ${String(method)}`);
      if (options?.signal?.aborted) throw new Error('CANCELLED');
      const result = await handler(context, args as never, {
        ...immediate,
        cancelled: () => Boolean(options?.signal?.aborted),
        progress: (data: unknown) => options?.onProgress?.(data),
      });
      if (options?.signal?.aborted) throw new Error('CANCELLED');
      return result as EngineOps[K]['result'];
    },
    terminate() {
      for (const doc of context.documents.values()) doc.pdf.destroy();
      context.documents.clear();
    },
  };
}
