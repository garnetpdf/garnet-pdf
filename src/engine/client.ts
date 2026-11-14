import type { EngineCallOptions, EngineClient, EngineOps } from '../shared/engine-api';

interface Pending {
  worker: Worker;
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (value: unknown) => void;
  abort?: () => void;
  signal?: AbortSignal;
}

export function createEngineClient(): EngineClient {
  interface WorkerState { worker: Worker; ready: Promise<void>; failReady(error: Error): void }
  const workers = new Map<string, WorkerState>();
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const onMessage = (event: MessageEvent) => {
    const message = event.data as { id: number; type?: string; ok?: boolean; result?: unknown; error?: string; data?: unknown };
    const call = pending.get(message.id);
    if (!call) return;
    if (message.type === 'progress') { call.onProgress?.(message.data); return; }
    pending.delete(message.id);
    if (call.signal && call.abort) call.signal.removeEventListener('abort', call.abort);
    if (message.ok) call.resolve(message.result);
    else call.reject(new Error(message.error || 'PDF engine failed.'));
  };
  const newWorker = () => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => failReady(new Error('PDF engine did not start within 20 seconds.')), 20_000);
    const failReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      rejectReady(error);
      worker.terminate();
    };
    worker.onmessage = event => {
      if (event.data?.type === 'ready') {
        if (!readySettled) { readySettled = true; clearTimeout(timer); resolveReady(); }
        return;
      }
      onMessage(event);
    };
    worker.onerror = event => {
      failReady(new Error(event.message || 'PDF engine worker failed.'));
      for (const [id, call] of pending) {
        if (call.worker !== worker) continue;
        pending.delete(id);
        call.reject(new Error(event.message || 'PDF engine worker failed.'));
      }
      for (const [docId, activeWorker] of workers) if (activeWorker.worker === worker) workers.delete(docId);
      worker.terminate();
    };
    return { worker, ready, failReady };
  };

  return {
    call<K extends keyof EngineOps>(method: K, args: EngineOps[K]['args'], options?: EngineCallOptions): Promise<EngineOps[K]['result']> {
      const id = nextId++;
      if (options?.signal?.aborted) return Promise.reject(new Error('CANCELLED'));
      const opening = method === 'core.open';
      const docId = opening ? `doc-${crypto.randomUUID()}` : (args as { docId: string }).docId;
      const state = opening ? newWorker() : workers.get(docId);
      if (!state) return Promise.reject(new Error('Document is closed or unavailable.'));
      const { worker } = state;
      if (opening) workers.set(docId, state);
      return new Promise((resolve, reject) => {
        let posted = false;
        const call: Pending = {
          worker,
          resolve: value => {
            if (method === 'core.close') { workers.delete(docId); worker.terminate(); }
            (resolve as (value: unknown) => void)(value);
          },
          reject: error => {
            if (opening) { workers.delete(docId); state.failReady(error); worker.terminate(); }
            reject(error);
          },
          onProgress: options?.onProgress, signal: options?.signal,
        };
        if (options?.signal) {
          call.abort = () => {
            if (posted) worker.postMessage({ type: 'cancel', id });
            else { pending.delete(id); call.reject(new Error('CANCELLED')); }
          };
          options.signal.addEventListener('abort', call.abort, { once: true });
        }
        pending.set(id, call);
        const transfers: Transferable[] = [];
        if (method === 'core.open') {
          const bytes = (args as EngineOps['core.open']['args']).bytes;
          transfers.push(bytes);
        }
        void state.ready.then(() => {
          if (!pending.has(id)) return;
          try {
            posted = true;
            worker.postMessage({ type: 'call', id, method, args: opening ? { ...args, docId } : args, priority: options?.priority ?? 0 }, transfers);
          } catch (error) {
            pending.delete(id);
            call.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }).catch(error => {
          if (!pending.has(id)) return;
          pending.delete(id);
          call.reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
    terminate() {
      for (const state of workers.values()) { state.failReady(new Error('PDF engine closed.')); state.worker.terminate(); }
      workers.clear();
      for (const call of pending.values()) call.reject(new Error('PDF engine closed.'));
      pending.clear();
    },
  };
}

/** Run a long op against a deep-copy snapshot in a disposable worker. */
export async function runDisposableEngineOp<K extends keyof EngineOps>(
  source: EngineClient,
  sourceDocId: string,
  method: K,
  args: Omit<EngineOps[K]['args'], 'docId'>,
  options?: EngineCallOptions,
): Promise<EngineOps[K]['result']> {
  const snapshot = await source.call('core.snapshot', { docId: sourceDocId });
  const isolated = createEngineClient();
  try {
    const opened = await isolated.call('core.open', { bytes: snapshot.bytes });
    return await isolated.call(method, { ...args, docId: opened.docId } as EngineOps[K]['args'], options);
  } finally { isolated.terminate(); }
}
