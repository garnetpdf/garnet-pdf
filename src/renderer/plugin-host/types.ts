import type { ComponentType, ReactNode } from 'react';
import type { EngineClient, PageId } from '../../shared/engine-api';
import type { GarnetSettings as Settings } from '../../shared/ipc';

export type Mode =
  'View' | 'Organize' | 'Edit' | 'Comment' | 'Fill & Sign' | 'Protect' | 'Tools' | (string & {});
export type Point = [number, number];
export type Rect = [number, number, number, number];
export type Matrix = [number, number, number, number, number, number];
export type Dispose = () => void;
export interface Command {
  id: string;
  title: string;
  shortcut?: string;
  icon?: ComponentType<{ size?: number }>;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}
export interface ToolbarItem {
  id: string;
  command: string;
  label?: string;
}
export interface PanelDefinition {
  id: string;
  title: string;
  component: ComponentType;
  /** Icon for the narrow left rail (a lucide icon); panels without one get a generic panel icon. */
  icon?: ComponentType<{ size?: number }>;
}
export interface MenuItem {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}
export interface Tool {
  id: string;
  cursor: string;
  onPointerDown?: (page: EditPage, point: Point) => void;
  onPointerMove?: (page: EditPage, point: Point) => void;
  onPointerUp?: (page: EditPage, point: Point) => void;
  overlay?: ComponentType<{ page: EditPage }>;
}
export interface SelectionItem {
  id: string;
  providerId: string;
  kind: string;
  pageId: PageId;
  bounds: Rect;
  data?: unknown;
}
/** Coordinates are in unrotated MuPDF page user space (points, top-left origin).
 * pageToView and its inverse include PDF /Rotate, in the page canvas.
 * viewRotation is the additional CSS view angle. Use fullViewMatrix/viewPointToPage
 * for physical screen coordinates, including that additional rotation.
 * IDs belong to providers; the host never reads or modifies PDF content. */
export interface EditPage {
  docId: string;
  pageId: PageId;
  width: number;
  height: number;
  rotation: number;
  viewRotation?: number;
  pageToView: Matrix;
  viewToPage: Matrix;
}
export interface EditProvider {
  id: string;
  kinds: readonly string[];
  hitTest: (page: EditPage, point: Point) => SelectionItem | null | Promise<SelectionItem | null>;
  hoverCandidates: (page: EditPage) => SelectionItem[] | Promise<SelectionItem[]>;
  onActivate?: (selection: SelectionItem[], page: EditPage) => void | Promise<void>;
  onTransform: (selection: SelectionItem[], matrix: Matrix, page: EditPage) => void | Promise<void>;
  onDelete?: (selection: SelectionItem[], page: EditPage) => void | Promise<void>;
  contextMenu?: (selection: SelectionItem[], page: EditPage) => MenuItem[];
  overlay?: ComponentType<{ page: EditPage }>;
}
export interface HistoryAction {
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}
export type DocumentEvent = 'opened' | 'changed' | 'saved' | 'closed';
export interface ActiveDocument {
  docId: string;
  name: string;
  pageId: PageId;
  pageCount: number;
}
export interface PluginContext {
  commands: { register(command: Command): Dispose };
  keybindings: { register(shortcut: string, command: string): Dispose };
  toolbar: { addItem(mode: Mode, item: ToolbarItem): Dispose };
  modes: { register(mode: { id: Mode; label: string }): Dispose };
  panels: { register(side: 'left' | 'right', panel: PanelDefinition): Dispose };
  contextMenu: { add(target: string, item: MenuItem): Dispose };
  tools: {
    register(tool: Tool): Dispose;
    activate(id: string | null): void;
    active(): string | null;
  };
  inspector: {
    register(kind: string, component: ComponentType<{ selection: SelectionItem[] }>): Dispose;
  };
  edit: { registerProvider(provider: EditProvider): Dispose };
  engine: EngineClient;
  documents: {
    active(): ActiveDocument | null;
    subscribe(event: DocumentEvent, fn: (doc: ActiveDocument) => void): Dispose;
  };
  selection: {
    get(): SelectionItem[];
    set(items: SelectionItem[]): void;
    subscribe(fn: () => void): Dispose;
  };
  settings: { get(): Settings; set(patch: Partial<Settings>): Promise<void> };
  ui: {
    dialog(content: ReactNode, title?: string): Promise<void>;
    toast(message: string): void;
    confirm(message: string): Promise<boolean>;
    prompt(message: string, initial?: string): Promise<string | null>;
  };
  /** One gesture = one outer engine transaction, including mixed providers.
   * Optional local action supports overlays that do not change the PDF. */
  history: { run<T>(label: string, fn: () => Promise<T> | T, local?: HistoryAction): Promise<T> };
}
export interface Plugin {
  id: string;
  name: string;
  version: string;
  activate(ctx: PluginContext): void | Dispose;
}
export const definePlugin = (plugin: Plugin): Plugin => plugin;
export interface PluginLoader {
  load(): Promise<Plugin[]>;
}
export const externalPluginLoader: PluginLoader = {
  async load() {
    return [];
  },
};
