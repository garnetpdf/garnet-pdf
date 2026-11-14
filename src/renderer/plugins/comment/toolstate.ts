/** Comment tool definitions and remembered tool styles (kept in local storage, no PDF data). */
import { create } from 'zustand';
import type { RGB } from '../../../engine/tools/annots/types';

export type CommentTool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'squiggly'
  | 'note'
  | 'textbox'
  | 'callout'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polyline'
  | 'polygon'
  | 'cloud'
  | 'ink'
  | 'stamp';

export interface ToolStyle {
  color: RGB;
  fill: RGB | null;
  width: number;
  opacity: number;
  fontSize: number;
  dashed: boolean;
}

export interface StampChoice {
  /** Standard or custom stamp name for text stamps. */
  icon?: string;
  label: string;
  color?: RGB;
  /** Stored custom image stamp. */
  imageId?: string;
}

export const BUILTIN_STAMPS: StampChoice[] = [
  { icon: 'Approved', label: 'Approved', color: [0.09, 0.5, 0.2] },
  { icon: 'Draft', label: 'Draft', color: [0.16, 0.35, 0.8] },
  { icon: 'Confidential', label: 'Confidential', color: [0.75, 0.1, 0.12] },
  { icon: 'RECEIVED', label: 'Received', color: [0.16, 0.35, 0.8] },
  { icon: 'ForComment', label: 'For comment', color: [0.8, 0.42, 0.05] },
];

const red: RGB = [0.83, 0.13, 0.15];
export const DEFAULT_STYLES: Record<CommentTool, ToolStyle> = {
  select: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  highlight: { color: [1, 0.85, 0.2], fill: null, width: 1, opacity: 1, fontSize: 12, dashed: false },
  underline: { color: [0.1, 0.55, 0.22], fill: null, width: 1, opacity: 1, fontSize: 12, dashed: false },
  strike: { color: red, fill: null, width: 1, opacity: 1, fontSize: 12, dashed: false },
  squiggly: { color: [0.2, 0.4, 0.9], fill: null, width: 1, opacity: 1, fontSize: 12, dashed: false },
  note: { color: [1, 0.82, 0.1], fill: null, width: 1, opacity: 1, fontSize: 12, dashed: false },
  textbox: { color: [0, 0, 0], fill: null, width: 0, opacity: 1, fontSize: 12, dashed: false },
  callout: { color: red, fill: [1, 1, 1], width: 1, opacity: 1, fontSize: 11, dashed: false },
  rect: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  ellipse: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  line: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  arrow: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  polyline: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  polygon: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  cloud: { color: red, fill: null, width: 1.5, opacity: 1, fontSize: 12, dashed: false },
  ink: { color: [0.12, 0.3, 0.85], fill: null, width: 2, opacity: 1, fontSize: 12, dashed: false },
  stamp: { color: [0.16, 0.35, 0.8], fill: null, width: 1, opacity: 1, fontSize: 12, dashed: false },
};

export const SWATCHES: RGB[] = [
  [1, 0.85, 0.2],
  [0.55, 0.85, 0.35],
  [0.4, 0.75, 1],
  [1, 0.55, 0.75],
  [0.83, 0.13, 0.15],
  [0.12, 0.3, 0.85],
  [0.1, 0.55, 0.22],
  [0, 0, 0],
];

const STORAGE_KEY = 'garnet.comment.toolStyles.v1';
function loadStyles(): Record<CommentTool, ToolStyle> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<Record<CommentTool, Partial<ToolStyle>>>;
    const out = { ...DEFAULT_STYLES };
    for (const key of Object.keys(out) as CommentTool[]) out[key] = { ...DEFAULT_STYLES[key], ...(saved[key] || {}) };
    return out;
  } catch {
    return { ...DEFAULT_STYLES };
  }
}

interface ToolState {
  tool: CommentTool;
  styles: Record<CommentTool, ToolStyle>;
  stamp: StampChoice;
  setStyle: (tool: CommentTool, patch: Partial<ToolStyle>) => void;
  set: (patch: Partial<Pick<ToolState, 'tool' | 'stamp'>>) => void;
}

export const useTools = create<ToolState>((set, get) => ({
  tool: 'select',
  styles: typeof localStorage === 'undefined' ? { ...DEFAULT_STYLES } : loadStyles(),
  stamp: BUILTIN_STAMPS[0],
  setStyle: (tool, patch) => {
    const styles = { ...get().styles, [tool]: { ...get().styles[tool], ...patch } };
    set({ styles });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
    } catch {
      // Storage is optional.
    }
  },
  set: (patch) => set(patch),
}));

export const toCss = (c: RGB | null | undefined, alpha = 1) =>
  c ? `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})` : 'transparent';

export function toHex(c: RGB | null | undefined): string {
  if (!c) return '#000000';
  return `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Maps an annotation type back to the tool whose remembered style it should update. */
export function toolForType(type: string, extra: { arrow?: boolean; cloud?: boolean; callout?: boolean } = {}): CommentTool | null {
  switch (type) {
    case 'Highlight':
      return 'highlight';
    case 'Underline':
      return 'underline';
    case 'StrikeOut':
      return 'strike';
    case 'Squiggly':
      return 'squiggly';
    case 'Text':
      return 'note';
    case 'FreeText':
      return extra.callout ? 'callout' : 'textbox';
    case 'Square':
      return 'rect';
    case 'Circle':
      return 'ellipse';
    case 'Line':
      return extra.arrow ? 'arrow' : 'line';
    case 'PolyLine':
      return 'polyline';
    case 'Polygon':
      return extra.cloud ? 'cloud' : 'polygon';
    case 'Ink':
      return 'ink';
    case 'Stamp':
      return 'stamp';
    default:
      return null;
  }
}
