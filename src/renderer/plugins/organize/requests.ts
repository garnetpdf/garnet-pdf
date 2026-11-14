/** Requests from the Organize grid to the page tool dialogs (kept apart so neither plugin imports the other's UI). */
import { create } from 'zustand';

export type ToolKind =
  | 'insert'
  | 'insertBlank'
  | 'extract'
  | 'split'
  | 'delete'
  | 'replace'
  | 'crop'
  | 'pageSize'
  | 'nup'
  | 'headerFooter'
  | 'watermark'
  | 'background'
  | 'labels'
  | 'combine'
  | 'blank'
  | 'more';

export interface ToolRequest {
  kind: ToolKind;
  /** Insert position (zero-based gap index) for the insert dialogs. */
  at?: number;
  /** Screen position for the More menu. */
  x?: number;
  y?: number;
  seq: number;
}

let seq = 0;
export const useToolRequest = create<{ request: ToolRequest | null; set: (request: ToolRequest | null) => void }>((set) => ({
  request: null,
  set: (request) => set({ request }),
}));

export function requestTool(kind: ToolKind, extra: Omit<ToolRequest, 'kind' | 'seq'> = {}): void {
  useToolRequest.getState().set({ kind, ...extra, seq: ++seq });
}
