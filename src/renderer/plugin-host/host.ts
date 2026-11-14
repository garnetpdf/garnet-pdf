import type { ComponentType } from 'react';
import type { EngineClient } from '../../shared/engine-api';
import type { GarnetSettings as Settings } from '../../shared/ipc';
import type {
  ActiveDocument,
  Command,
  Dispose,
  DocumentEvent,
  EditProvider,
  HistoryAction,
  MenuItem,
  Mode,
  PanelDefinition,
  Plugin,
  PluginContext,
  SelectionItem,
  Tool,
  ToolbarItem,
} from './types';

export interface HostBridge {
  engine: EngineClient;
  active(): ActiveDocument | null;
  getSettings(): Settings;
  setSettings(patch: Partial<Settings>): Promise<void>;
  ui: PluginContext['ui'];
  transaction<T>(label: string, fn: () => T | Promise<T>): Promise<T>;
}
export class PluginHost {
  readonly commands = new Map<string, Command>();
  readonly keybindings = new Map<string, string>();
  readonly toolbar = new Map<Mode, ToolbarItem[]>();
  readonly modes = new Map<Mode, string>();
  readonly panels = {
    left: new Map<string, PanelDefinition>(),
    right: new Map<string, PanelDefinition>(),
  };
  readonly menus = new Map<string, MenuItem[]>();
  readonly tools = new Map<string, Tool>();
  readonly inspectors = new Map<string, ComponentType<{ selection: SelectionItem[] }>>();
  readonly providers = new Map<string, EditProvider>();
  readonly plugins = new Map<string, Dispose>();
  private listeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private events = new Map<DocumentEvent, Set<(doc: ActiveDocument) => void>>();
  private selected: SelectionItem[] = [];
  private version = 0;
  activeTool: string | null = null;
  private localHistory: { label: string; action: HistoryAction; docId: string | null }[] = [];
  private transactionDepth = 0;
  /** Resolves when the change now being recorded is complete. */
  private recording: Promise<void> = Promise.resolve();
  private pendingLocal: HistoryAction[] = [];
  private localPosition = 0;
  readonly ctx: PluginContext;
  constructor(readonly bridge: HostBridge) {
    const reg = <T>(map: Map<string, T>, id: string, value: T): Dispose => {
      if (map.has(id)) throw new Error(`Already registered: ${id}`);
      map.set(id, value);
      this.emit();
      return () => {
        map.delete(id);
        this.emit();
      };
    };
    const add = <T>(map: Map<string, T[]>, id: string, value: T): Dispose => {
      map.set(id, [...(map.get(id) || []), value]);
      this.emit();
      return () => {
        map.set(
          id,
          (map.get(id) || []).filter((x) => x !== value),
        );
        this.emit();
      };
    };
    this.ctx = {
      commands: { register: (c) => reg(this.commands, c.id, c) },
      keybindings: { register: (k, c) => reg(this.keybindings, normalizeShortcut(k), c) },
      toolbar: { addItem: (m, i) => add(this.toolbar, m, i) },
      modes: { register: (m) => reg(this.modes, m.id, m.label) },
      panels: { register: (s, p) => reg(this.panels[s], p.id, p) },
      contextMenu: { add: (t, i) => add(this.menus, t, i) },
      tools: {
        register: (t) => reg(this.tools, t.id, t),
        activate: (id) => {
          if (id && !this.tools.has(id)) throw new Error('Unknown tool');
          this.activeTool = id;
          this.emit();
        },
        active: () => this.activeTool,
      },
      inspector: { register: (k, c) => reg(this.inspectors, k, c) },
      edit: { registerProvider: (p) => reg(this.providers, p.id, p) },
      engine: bridge.engine,
      documents: {
        active: () => bridge.active(),
        subscribe: (e, fn) => {
          const set = this.events.get(e) || new Set();
          set.add(fn);
          this.events.set(e, set);
          return () => set.delete(fn);
        },
      },
      selection: {
        get: () => this.selected,
        set: (s) => {
          this.selected = s;
          this.selectionListeners.forEach((f) => f());
          this.emit();
        },
        subscribe: (fn) => {
          this.selectionListeners.add(fn);
          return () => this.selectionListeners.delete(fn);
        },
      },
      settings: { get: () => bridge.getSettings(), set: (p) => bridge.setSettings(p) },
      ui: bridge.ui,
      history: {
        run: async (label, fn, local) => {
          if (this.transactionDepth) {
            const result = await fn();
            if (local) this.pendingLocal.push(local);
            return result;
          }
          this.transactionDepth++;
          this.pendingLocal = [];
          let recorded!: () => void;
          this.recording = new Promise<void>((resolve) => (recorded = resolve));
          try {
            const result = await bridge.transaction(label, async () => {
              const value = await fn();
              if (local) this.pendingLocal.push(local);
              return value;
            });
            if (this.pendingLocal.length) {
              const actions = [...this.pendingLocal];
              this.localHistory.splice(this.localPosition);
              this.localHistory.push({
                label,
                docId: bridge.active()?.docId || null,
                action: {
                  undo: async () => {
                    for (const action of [...actions].reverse()) await action.undo();
                  },
                  redo: async () => {
                    for (const action of actions) await action.redo();
                  },
                },
              });
              this.localPosition++;
              this.emit();
            }
            return result;
          } catch (error) {
            for (const action of [...this.pendingLocal].reverse()) await action.undo();
            throw error;
          } finally {
            this.transactionDepth--;
            this.pendingLocal = [];
            recorded();
          }
        },
      },
    };
  }
  /**
   * Undo or redo pressed while a change is still being recorded waits for it. Without this, the step
   * was not in the history yet and the key press went to an older step or did nothing.
   */
  private async whenRecorded(): Promise<void> {
    while (this.transactionDepth) await this.recording;
  }
  subscribe = (fn: () => void): Dispose => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = (): number => this.version;
  emit(): void {
    this.version++;
    this.listeners.forEach((f) => f());
  }
  emitDocument(e: DocumentEvent, doc: ActiveDocument): void {
    this.events.get(e)?.forEach((fn) => fn(doc));
  }
  activate(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin already active: ${plugin.id}`);
    const disposers: Dispose[] = [];
    // Scope every registration so deactivation releases all plugin-owned resources.
    const ctx = { ...this.ctx };
    for (const key of [
      'commands',
      'keybindings',
      'toolbar',
      'modes',
      'panels',
      'contextMenu',
      'tools',
      'inspector',
      'edit',
    ] as const) {
      const original = this.ctx[key];
      ctx[key] = new Proxy(original, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          return typeof value === 'function'
            ? (...args: unknown[]) => {
                const dispose = value(...args) as Dispose;
                if (typeof dispose === 'function') disposers.push(dispose);
                return dispose;
              }
            : value;
        },
      }) as (typeof ctx)[typeof key] & never;
    }
    try {
      const cleanup = plugin.activate(ctx);
      this.plugins.set(plugin.id, () => {
        cleanup?.();
        disposers.reverse().forEach((d) => d());
      });
    } catch (error) {
      disposers.reverse().forEach((d) => d());
      throw error;
    }
  }
  deactivate(id: string): void {
    this.plugins.get(id)?.();
    this.plugins.delete(id);
  }
  async execute(id: string): Promise<void> {
    const c = this.commands.get(id);
    if (!c) throw new Error(`Unknown command: ${id}`);
    if (c.enabled && !c.enabled()) return;
    await c.run();
  }
  async undoLocal(): Promise<boolean> {
    await this.whenRecorded();
    if (
      !this.localPosition ||
      this.localHistory[this.localPosition - 1].docId !== (this.bridge.active()?.docId || null)
    )
      return false;
    await this.localHistory[--this.localPosition].action.undo();
    this.emit();
    return true;
  }
  async redoLocal(): Promise<boolean> {
    await this.whenRecorded();
    if (
      this.localPosition >= this.localHistory.length ||
      this.localHistory[this.localPosition].docId !== (this.bridge.active()?.docId || null)
    )
      return false;
    await this.localHistory[this.localPosition++].action.redo();
    this.emit();
    return true;
  }
  getLocalHistory() {
    return { position: this.localPosition, steps: this.localHistory.map((x) => x.label) };
  }
}
export function normalizeShortcut(value: string): string {
  return value.toLowerCase().replace(/\s/g, '').replace('control', 'ctrl');
}
export function shortcutForEvent(e: KeyboardEvent): string {
  return [
    e.ctrlKey || e.metaKey ? 'ctrl' : '',
    e.altKey ? 'alt' : '',
    e.shiftKey ? 'shift' : '',
    e.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join('+');
}
export function discoverPlugins(): Plugin[] {
  const modules = import.meta.glob<{ default: Plugin }>('../plugins/*/index.{ts,tsx}', {
    eager: true,
  });
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, m]) => m.default);
}
