/**
 * Form field state for the active document, shared by the Forms (View mode) and Fill & Sign plugins.
 * Every value change is one engine call (one undo step); MuPDF regenerates the field appearance.
 */
import { create } from 'zustand';
import type { PluginContext } from '../../plugin-host/types';
import { activeTab, useApp } from '../../store';
import type { FormWidget } from '../../../engine/tools/forms/types';

export type { FormWidget };

const HIGHLIGHT_KEY = 'garnet.forms.highlight';
function storedHighlight(): boolean {
  try {
    return localStorage.getItem(HIGHLIGHT_KEY) !== '0';
  } catch {
    return true;
  }
}

interface FormsState {
  docId: string | null;
  revision: number;
  widgets: FormWidget[];
  hasScripts: boolean;
  unsupportedCalculations: number;
  highlight: boolean;
  set: (patch: Partial<Omit<FormsState, 'set'>>) => void;
}

export const useForms = create<FormsState>((set) => ({
  docId: null,
  revision: -1,
  widgets: [],
  hasScripts: false,
  unsupportedCalculations: 0,
  highlight: typeof localStorage === 'undefined' ? true : storedHighlight(),
  set: (patch) => set(patch),
}));

export function setHighlight(on: boolean) {
  useForms.getState().set({ highlight: on });
  try {
    localStorage.setItem(HIGHLIGHT_KEY, on ? '1' : '0');
  } catch {
    // Optional preference.
  }
}

let context: PluginContext | null = null;
let refreshing: Promise<void> | null = null;
let again = false;
const listeners = new Set<(docId: string) => void>();

/** Called once per document after its fields are first read (used for the scripts notice). */
export function onFormsLoaded(fn: (docId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function refreshForms(force = false): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      const tab = activeTab();
      const state = useForms.getState();
      if (!tab || !context) {
        if (state.docId) state.set({ docId: null, widgets: [], hasScripts: false, unsupportedCalculations: 0 });
        continue;
      }
      if (!force && state.docId === tab.info.docId && state.revision === tab.info.revision) continue;
      force = false;
      try {
        const result = await context.engine.call('forms.list', { docId: tab.info.docId });
        const current = activeTab();
        if (!current || current.info.docId !== tab.info.docId) {
          again = true;
          continue;
        }
        const first = state.docId !== tab.info.docId;
        useForms.getState().set({
          docId: tab.info.docId,
          revision: tab.info.revision,
          widgets: result.widgets,
          hasScripts: result.hasScripts,
          unsupportedCalculations: result.unsupportedCalculations,
        });
        if (first) listeners.forEach((fn) => fn(tab.info.docId));
      } catch {
        // Closed while reading; the next change triggers another read.
      }
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const owners = new Set<string>();
export function connectForms(ctx: PluginContext, owner: string): () => void {
  owners.add(owner);
  if (!context) context = ctx;
  const off = useApp.subscribe((s, previous) => {
    const tab = s.tabs.find((t) => t.info.docId === s.activeId);
    const before = previous.tabs.find((t) => t.info.docId === previous.activeId);
    if (s.activeId !== previous.activeId || tab?.info.revision !== before?.info.revision) void refreshForms();
  });
  void refreshForms();
  return () => {
    off();
    owners.delete(owner);
    if (!owners.size) context = null;
  };
}

function ctx(): PluginContext {
  if (!context) throw new Error('Forms are not ready yet.');
  return context;
}

function report(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  context?.ui.toast(message.replace(/^Error:\s*/, ''));
}

/**
 * Shows a check box or radio change at once (a radio group's other buttons turn off) while the engine
 * applies it; the refresh after the engine call replaces this with the document's real state.
 */
export function showToggle(widget: FormWidget, checked: boolean) {
  useForms.setState((s) => ({
    widgets: s.widgets.map((x) => {
      if (x.id === widget.id && x.pageId === widget.pageId) return { ...x, checked };
      if (checked && widget.type === 'radio' && x.type === 'radio' && x.name === widget.name) return { ...x, checked: false };
      return x;
    }),
  }));
}

export async function setFieldValue(
  widget: FormWidget,
  patch: { value?: string; values?: string[]; checked?: boolean },
): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  try {
    await ctx().engine.call('forms.setValue', {
      docId: tab.info.docId,
      pageId: widget.pageId,
      id: widget.id,
      ...patch,
      calculate: !!ctx().settings.get().enableJavaScript,
    });
    await refreshForms(true);
    return true;
  } catch (error) {
    report(error);
    await refreshForms(true);
    return false;
  }
}

export async function resetForm(): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  try {
    await ctx().engine.call('forms.reset', { docId: tab.info.docId });
    await refreshForms(true);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function flattenForm(): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  try {
    await ctx().engine.call('forms.flatten', { docId: tab.info.docId });
    await refreshForms(true);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

/** Same test as the engine: values with letters the field appearance cannot draw (for example Arabic). */
export const OUTSIDE_STANDARD_FONTS = /[^\t\n\r\u0020-\u024f\u02b0-\u036f\u1e00-\u1eff\u2000-\u206f\u20a0-\u20bf\u2100-\u214f]/;
