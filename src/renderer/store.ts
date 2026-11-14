import { create } from 'zustand';
import type { DocumentInfo, SearchHit } from '../shared/engine-api';
import type { FileDescriptor, GarnetSettings } from '../shared/ipc';
import type { Mode } from './plugin-host/types';
export interface Tab {
  recoverySourceId?: string;
  info: DocumentInfo;
  file: FileDescriptor;
  page: number;
  zoom: number;
  /** Keep the page fitted to the view as the view changes size, until a zoom level is chosen. */
  fit?: 'width' | 'page';
  rotation: number;
  layout: 'continuous' | 'single' | 'two-page' | 'cover';
}
export interface AppState {
  platform: string;
  tabs: Tab[];
  activeId: string | null;
  mode: Mode;
  sidebar: string;
  inspector: boolean;
  settings: GarnetSettings;
  query: string;
  hits: SearchHit[];
  hitIndex: number;
  findOpen: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  hand: boolean;
  presentation: boolean;
  set: (patch: Partial<AppState>) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  updateInfo: (id: string, patch: Partial<DocumentInfo>) => void;
}
export const useApp = create<AppState>((set) => ({
  platform: 'linux',
  tabs: [],
  activeId: null,
  mode: 'View',
  sidebar: 'Thumbnails',
  inspector: false,
  settings: {
    theme: 'light',
    defaultZoom: 'fit-width',
    authorName: '',
    enableJavaScript: false,
    recoveryIntervalSeconds: 60,
  },
  query: '',
  hits: [],
  hitIndex: 0,
  findOpen: false,
  caseSensitive: false,
  wholeWord: false,
  hand: false,
  presentation: false,
  set: (patch) => set(patch),
  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.info.docId === id ? { ...t, ...patch } : t)) })),
  updateInfo: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.info.docId === id ? { ...t, info: { ...t.info, ...patch } } : t)),
    })),
}));
export function activeTab() {
  const s = useApp.getState();
  return s.tabs.find((t) => t.info.docId === s.activeId);
}
