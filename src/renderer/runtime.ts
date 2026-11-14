import { create } from 'zustand';
import type { ReactNode } from 'react';
import { createEngineClient } from '../engine/client';
import type { EngineClient, EngineOps, OpResult } from '../shared/engine-api';
import { activeTab, useApp } from './store';
import { discoverPlugins, PluginHost } from './plugin-host/host';
const raw = createEngineClient();
export { actions } from './actions';
export interface UIRequest {
  kind: 'prompt' | 'confirm' | 'dialog' | 'close' | 'encryption' | 'print';
  title: string;
  initial?: string;
  content?: ReactNode;
  resolve: (v: string | null) => void;
}
export const useUI = create<{
  toast: string;
  request: UIRequest | null;
  set: (p: Partial<{ toast: string; request: UIRequest | null }>) => void;
}>((set) => ({ toast: '', request: null, set }));
let toastTimer: ReturnType<typeof setTimeout>;
export function toast(message: string) {
  useUI.getState().set({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => useUI.getState().set({ toast: '' }), 7000);
}
function request(kind: UIRequest['kind'], title: string, initial?: string, content?: ReactNode) {
  return new Promise<string | null>((resolve) =>
    useUI.getState().set({ request: { kind, title, initial, content, resolve } }),
  );
}
export const engine: EngineClient = {
  terminate: () => raw.terminate(),
  async call<K extends keyof EngineOps>(
    method: K,
    args: EngineOps[K]['args'],
    options?: Parameters<EngineClient['call']>[2],
  ): Promise<EngineOps[K]['result']> {
    const result = await raw.call(method, args, options);
    if (
      method !== 'core.history' &&
      (!transactionDepth ||
        method === 'core.endTransaction' ||
        method === 'core.abortTransaction') &&
      result &&
      typeof result === 'object' &&
      'journal' in result &&
      'changedPages' in result &&
      args &&
      typeof args === 'object' &&
      'docId' in args
    ) {
      const r = result as OpResult;
      if (r.historyDropped)
        toast('Older undo steps were cleared to keep this document safe and responsive.');
      useApp.getState().updateInfo(String(args.docId), {
        pages: r.pages,
        pageCount: r.pageCount,
        dirty: r.dirty,
        revision: r.revision,
      });
      const tab = activeTab();
      if (tab) {
        if (tab.page >= r.pageCount)
          useApp.getState().updateTab(tab.info.docId, { page: Math.max(0, r.pageCount - 1) });
        host.emitDocument('changed', {
          docId: tab.info.docId,
          name: tab.file.name,
          pageId: tab.info.pages[tab.page]?.id,
          pageCount: r.pageCount,
        });
      }
      host.emit();
    }
    return result;
  },
};
let transactionDepth = 0;
export const host = new PluginHost({
  engine,
  active: () => {
    const tab = activeTab();
    return tab
      ? {
          docId: tab.info.docId,
          name: tab.file.name,
          pageId: tab.info.pages[tab.page]?.id,
          pageCount: tab.info.pageCount,
        }
      : null;
  },
  getSettings: () => useApp.getState().settings,
  setSettings: async (patch) => {
    const settings = await window.garnet.settings.set(patch);
    useApp.getState().set({ settings });
  },
  ui: {
    toast,
    prompt: (m, i) => request('prompt', m, i),
    confirm: async (m) => (await request('confirm', m)) === 'yes',
    dialog: async (content, title) => {
      await request('dialog', title || 'Garnet PDF', undefined, content);
    },
  },
  transaction: async (label, fn) => {
    const tab = activeTab();
    if (!tab || transactionDepth) return await fn();
    transactionDepth++;
    await engine.call('core.beginTransaction', { docId: tab.info.docId, label });
    try {
      const result = await fn();
      await engine.call('core.endTransaction', { docId: tab.info.docId });
      return result;
    } catch (error) {
      await engine.call('core.abortTransaction', { docId: tab.info.docId });
      throw error;
    } finally {
      transactionDepth--;
    }
  },
});
export function initializePlugins() {
  for (const plugin of discoverPlugins()) host.activate(plugin);
}
export async function closeChoice(name: string) {
  return request('close', `Save changes to ${name}?`);
}

export async function encryptionChoice(recovered = false) {
  return request('encryption', 'Save encrypted document', recovered ? 'recovery' : undefined);
}

export function printChoice(total: number) {
  return request('print', 'Print document', String(total));
}
