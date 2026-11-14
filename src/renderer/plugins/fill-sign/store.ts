/**
 * Renderer side of the saved signature / initials / image stamp list. The list is kept encrypted by
 * the main process; when the system cannot protect it, items stay in memory for this session only.
 */
import { create } from 'zustand';
import type { StoredSignItem, StoredSignKind } from '../../../main/ipc/sign-store-bridge';

export type { StoredSignItem, StoredSignKind };

interface SignStoreState {
  loaded: boolean;
  persistent: boolean;
  reason?: string;
  items: StoredSignItem[];
}

export const useSignStore = create<SignStoreState>(() => ({ loaded: false, persistent: false, items: [] }));

let loading: Promise<void> | null = null;
export function loadSignStore(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    const bridge = window.garnet?.signStore;
    if (!bridge) {
      useSignStore.setState({ loaded: true, persistent: false, reason: 'Saved signatures are not available in this build.' });
      return;
    }
    try {
      const state = await bridge.load();
      useSignStore.setState({ loaded: true, persistent: state.available, reason: state.reason, items: state.items });
    } catch (error) {
      useSignStore.setState({ loaded: true, persistent: false, reason: String(error) });
    }
  })();
  return loading;
}

async function persist(items: StoredSignItem[]): Promise<{ saved: boolean; reason?: string }> {
  useSignStore.setState({ items });
  const bridge = window.garnet?.signStore;
  if (!bridge || !useSignStore.getState().persistent) return { saved: false, reason: useSignStore.getState().reason };
  try {
    return await bridge.save(items);
  } catch (error) {
    return { saved: false, reason: String(error) };
  }
}

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** Adds an item; `remember: false` keeps it for this session only. Returns the stored item. */
export async function addSignItem(
  input: { kind: StoredSignKind; name: string; png: ArrayBuffer; width: number; height: number },
  remember: boolean,
): Promise<{ item: StoredSignItem; saved: boolean; reason?: string }> {
  await loadSignStore();
  const item: StoredSignItem = {
    id: newId(),
    kind: input.kind,
    name: input.name.slice(0, 120),
    png: bytesToBase64(input.png),
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
    created: Date.now(),
  };
  sessionItems.set(item.id, item);
  if (!remember) return { item, saved: false };
  const result = await persist([...useSignStore.getState().items, item]);
  return { item, ...result };
}

export async function removeSignItem(id: string) {
  sessionItems.delete(id);
  return persist(useSignStore.getState().items.filter((i) => i.id !== id));
}

/** Items used in this session but not saved (when the user unticks "Save for later"). */
const sessionItems = new Map<string, StoredSignItem>();

export function findSignItem(id: string): StoredSignItem | undefined {
  return useSignStore.getState().items.find((i) => i.id === id) ?? sessionItems.get(id);
}

export async function loadStoredImage(id: string): Promise<{ png: ArrayBuffer; width: number; height: number } | null> {
  await loadSignStore();
  const item = findSignItem(id);
  return item ? { png: base64ToBytes(item.png), width: item.width, height: item.height } : null;
}
