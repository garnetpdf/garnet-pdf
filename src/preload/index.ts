import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  GarnetBridge,
  SaveRequest,
  PrintRequest,
  SmokeResult,
  GarnetSettings,
  FileDescriptor,
} from '../shared/ipc';
import { createSignStoreBridge } from '../main/ipc/sign-store-bridge';
import { createP4bBridge } from '../main/ipc/p4b-contract';

const invoke = <T>(method: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(`garnet:${method}`, payload) as Promise<T>;

const bridge: GarnetBridge = {
  openDialog: () => invoke('open-dialog'),
  p4b: createP4bBridge(invoke),
  registerDroppedFile: (file) => {
    const path = webUtils.getPathForFile(file);
    if (!path) return Promise.reject(new Error('This file cannot be opened from a drop.'));
    return invoke('register-drop', path);
  },
  readFile: (handle) => invoke('read-file', handle),
  saveFile: (request: SaveRequest) => invoke('save-file', request),
  saveFiles: (request) => invoke('save-files', request),
  recent: {
    list: () => invoke('recent-list'),
    setThumbnail: (handle, png) => invoke('recent-thumbnail', { handle, png }),
    setView: (handle, state) => invoke('recent-view', { handle, state }),
    remove: (handle) => invoke('recent-remove', handle),
  },
  settings: {
    get: () => invoke('settings-get'),
    set: (patch: Partial<GarnetSettings>) => invoke('settings-set', patch),
  },
  recovery: {
    list: () => invoke('recovery-list'),
    write: (id, name, originalHandle, bytes, revision, encrypted) =>
      invoke('recovery-write', { id, name, originalHandle, bytes, revision, encrypted }),
    read: (id) => invoke('recovery-read', id),
    delete: (id) => invoke('recovery-delete', id),
  },
  fonts: {
    list: () => invoke('fonts-list'),
    read: (handle) => invoke('fonts-read', handle),
  },
  print: (request: PrintRequest) => invoke('print', request),
  printStream: {
    begin: (options) => invoke('print-begin', options || {}),
    addPage: (id, page) => invoke('print-add-page', { id, page }),
    finish: (id) => invoke('print-finish', id),
    cancel: (id) => invoke('print-cancel', id),
  },
  reveal: (handle) => invoke('reveal', handle),
  openExternal: (url) => invoke('open-external', url),
  window: {
    minimize: () => invoke('window-minimize'),
    maximize: () => invoke('window-maximize'),
    close: () => invoke('window-close'),
    fullscreen: (value) => invoke('window-fullscreen', value),
    isMaximized: () => invoke('window-is-maximized'),
    onFullScreen: (listener) => {
      const callback = (_event: Electron.IpcRendererEvent, value: boolean) => listener(value);
      ipcRenderer.on('garnet:fullscreen', callback);
      return () => ipcRenderer.removeListener('garnet:fullscreen', callback);
    },
  },
  menu: {
    onCommand: (listener) => {
      const callback = (_event: Electron.IpcRendererEvent, command: string) => listener(command);
      ipcRenderer.on('garnet:menu-command', callback);
      return () => ipcRenderer.removeListener('garnet:menu-command', callback);
    },
    setState: (state) => invoke('menu-state', state),
  },
  onCloseRequested: (listener) => {
    const callback = () => listener();
    ipcRenderer.on('garnet:close-requested', callback);
    return () => ipcRenderer.removeListener('garnet:close-requested', callback);
  },
  appInfo: () => invoke('app-info'),
  diagnostics: {
    networkAttempts: () => invoke('diagnostics-network-attempts'),
    allRequests: () => invoke('diagnostics-all-requests'),
  },
  startup: () => invoke('startup'),
  onOpenFiles: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, files: FileDescriptor[]) =>
      listener(files);
    ipcRenderer.on('garnet:open-files', callback);
    return () => ipcRenderer.removeListener('garnet:open-files', callback);
  },
  signStore: createSignStoreBridge(invoke),
  smoke: {
    request: () => invoke('smoke-request'),
    save: (bytes, expectedPageCount) => invoke('smoke-save', { bytes, expectedPageCount }),
    complete: (result: SmokeResult) => invoke('smoke-complete', result),
  },
};

contextBridge.exposeInMainWorld('garnet', bridge);
