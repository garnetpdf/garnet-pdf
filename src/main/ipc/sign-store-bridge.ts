/**
 * Fill & Sign saved signatures: renderer-facing contract. Pure types plus the preload factory, so the
 * preload bundle never imports Electron main-process modules.
 */
export type StoredSignKind = 'signature' | 'initials' | 'stamp';
export interface StoredSignItem {
  id: string;
  kind: StoredSignKind;
  name: string;
  /** PNG bytes, base64. */
  png: string;
  width: number;
  height: number;
  created: number;
}
export interface SignStoreState {
  /** False when the system cannot protect the file (no keyring); items then live for this session only. */
  available: boolean;
  reason?: string;
  items: StoredSignItem[];
}
export interface SignStoreBridge {
  load(): Promise<SignStoreState>;
  save(items: StoredSignItem[]): Promise<{ saved: boolean; reason?: string }>;
}

declare module '../../shared/ipc' {
  interface GarnetBridge {
    signStore?: SignStoreBridge;
  }
}

export function createSignStoreBridge(
  invoke: <T>(method: string, payload?: unknown) => Promise<T>,
): SignStoreBridge {
  return {
    load: () => invoke('sign-store-load'),
    save: (items) => invoke('sign-store-save', items),
  };
}
