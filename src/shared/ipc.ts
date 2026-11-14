import type { P4bBridge } from '../main/ipc/p4b-contract';
import type { MenuState } from './menu';
export type FileKind = 'pdf' | 'image';

/** File handles are random, window-local capabilities. No disk path crosses into the renderer. */
export interface FileDescriptor {
  handle: string;
  name: string;
  kind: FileKind;
  size: number;
  lastModified: number;
}

export interface RecentFile extends FileDescriptor {
  thumbnail?: string;
  lastOpened: number;
  viewState?: RecentViewState;
}
export interface RecentViewState {
  page: number;
  zoom: number;
  fit?: 'width' | 'page';
  rotation: number;
  layout: 'continuous' | 'single' | 'two-page' | 'cover';
}

export interface RecoveryEntry {
  id: string;
  name: string;
  originalHandle?: string;
  createdAt: number;
  revision: number;
  encrypted: boolean;
}

export interface FontEntry {
  family: string;
  style: string;
  handle: string;
}

export interface GarnetSettings {
  theme: 'light' | 'dark' | 'system';
  defaultZoom: 'fit-width' | 'fit-page' | 'actual' | number;
  authorName: string;
  enableJavaScript: boolean;
  recoveryIntervalSeconds: number;
}

export interface SaveRequest {
  handle?: string;
  bytes: ArrayBuffer;
  expectedPageCount: number;
  saveAs?: boolean;
  suggestedName?: string;
  hasSignatures?: boolean;
  redactionApplied?: boolean;
  recoveryId?: string;
  savedRevision?: number;
  verificationPassword?: string;
}

/** Several new PDFs written into one folder the user picks (split parts, extracted pages). */
export interface SaveFilesRequest {
  files: Array<{ name: string; bytes: ArrayBuffer; expectedPageCount: number }>;
  title?: string;
  /** Start the folder picker next to this open file. */
  nearHandle?: string;
}
export interface SaveFilesResult {
  folderName: string;
  files: FileDescriptor[];
}

export interface PrintRequest {
  /** PNG pixels are rendered at 300 dpi. Width and height are the PDF page size in points. */
  pages: Array<{ png: ArrayBuffer; width: number; height: number }>;
  copies?: number;
  landscape?: boolean;
  grayscale?: boolean;
  sizing?: 'actual' | 'fit';
}
export type PrintOptions = Omit<PrintRequest, 'pages'>;

export interface SmokeResult {
  checks: Record<string, boolean>;
  error?: string;
  timings?: Record<string, number>;
}

export interface GarnetBridge {
  openDialog(): Promise<FileDescriptor[]>;
  p4b: P4bBridge;
  registerDroppedFile(file: File): Promise<FileDescriptor>;
  readFile(handle: string): Promise<ArrayBuffer>;
  saveFile(request: SaveRequest): Promise<FileDescriptor | null>;
  saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult | null>;
  recent: {
    list(): Promise<RecentFile[]>;
    setThumbnail(handle: string, png: ArrayBuffer): Promise<void>;
    setView(handle: string, state: RecentViewState): Promise<void>;
    remove(handle: string): Promise<void>;
  };
  settings: {
    get(): Promise<GarnetSettings>;
    set(patch: Partial<GarnetSettings>): Promise<GarnetSettings>;
  };
  recovery: {
    list(): Promise<RecoveryEntry[]>;
    write(
      id: string,
      name: string,
      originalHandle: string | undefined,
      bytes: ArrayBuffer,
      revision?: number,
      encrypted?: boolean,
    ): Promise<void>;
    read(id: string): Promise<ArrayBuffer>;
    delete(id: string): Promise<void>;
  };
  fonts: {
    list(): Promise<FontEntry[]>;
    read(handle: string): Promise<ArrayBuffer>;
  };
  print(request: PrintRequest): Promise<void>;
  printStream: {
    begin(options?: PrintOptions): Promise<string>;
    addPage(id: string, page: PrintRequest['pages'][number]): Promise<void>;
    finish(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
  };
  reveal(handle: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    fullscreen(value: boolean): Promise<void>;
    isMaximized(): Promise<boolean>;
    /** Told when the window enters or leaves full screen, however that was asked for. */
    onFullScreen(listener: (fullscreen: boolean) => void): () => void;
  };
  /** The menu bar of a Mac (and the hidden shortcut menu elsewhere): its commands arrive here. */
  menu: {
    onCommand(listener: (command: string) => void): () => void;
    setState(state: MenuState): Promise<void>;
  };
  onCloseRequested(listener: () => void): () => void;
  diagnostics: { networkAttempts(): Promise<string[]>; allRequests(): Promise<string[]> };
  /** `packaged` is false for development and test runs (developer-only demos show there). */
  appInfo(): Promise<{ packaged: boolean; version: string }>;
  startup(): Promise<{ files: FileDescriptor[]; smoke: boolean; platform: NodeJS.Platform }>;
  onOpenFiles(listener: (files: FileDescriptor[]) => void): () => void;
  smoke: {
    request(): Promise<{ input: FileDescriptor } | null>;
    save(bytes: ArrayBuffer, expectedPageCount: number): Promise<FileDescriptor>;
    complete(result: SmokeResult): Promise<void>;
  };
}

declare global {
  interface Window {
    garnet: GarnetBridge;
  }
}
