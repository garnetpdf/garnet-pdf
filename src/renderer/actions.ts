import type { EngineOps } from '../shared/engine-api';
/** UI actions are bound by the shell. Plugins depend on this neutral registry, never the runtime. */
export const actions: Record<string, () => void | Promise<void>> = {};
/** Encryption applied when a document is next saved (set by Protect, read by the shell's save). */
export const saveProtection = new Map<
  string,
  NonNullable<EngineOps['core.save']['args']['encryption']>
>();
/** Documents with applied redactions or sanitizing: the next save purges recovery copies and backups and clears undo. */
export const redactionPending = new Set<string>();
/** Shell services bound by the app. */
export const shell: { openBytes?: (bytes: ArrayBuffer, name: string) => Promise<void> } = {};
