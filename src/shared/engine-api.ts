/** Shared wire contract. Feature op modules extend EngineOps by declaration merging. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EngineOps {}

export type PageId = number;
export type Rect = [number, number, number, number];
export type Quad = [number, number, number, number, number, number, number, number];
export interface PageInfo {
  id: PageId;
  index: number;
  width: number;
  height: number;
  rotation: number;
  label: string;
}
export interface JournalState {
  position: number;
  steps: string[];
}
export interface OpResult {
  journal: JournalState;
  changedPages: PageId[] | 'all';
  pageCount: number;
  dirty: boolean;
  revision: number;
  pages: PageInfo[];
  historyDropped?: boolean;
  encrypted?: boolean;
  encryptionMethod?: 'aes-256' | 'aes-128' | 'rc4-128' | 'rc4-40' | null;
  permissionsBits?: number | null;
}
export interface OutlineItem {
  title: string;
  page?: number;
  uri?: string;
  children?: OutlineItem[];
}
export interface DocumentInfo {
  docId: string;
  pageCount: number;
  pages: PageInfo[];
  outline: OutlineItem[];
  metadata: Record<string, string>;
  permissions: Record<string, boolean>;
  repaired: boolean;
  /** Raw engine messages from opening the file (technical; for logs and tests). */
  diagnostics?: string[];
  /** Plain-language notes for the user about what was repaired or left out when the file was opened. */
  notices?: string[];
  encrypted: boolean;
  encryptionMethod?: 'aes-256' | 'aes-128' | 'rc4-128' | 'rc4-40' | null;
  encryptionPermissions?: number | null;
  hasSignatures: boolean;
  dirty: boolean;
  revision: number;
}
export interface LinkInfo {
  bounds: Rect;
  uri: string;
  external: boolean;
}
export interface TextChar {
  c: string;
  origin: [number, number];
  quad: Quad;
  font: string;
  size: number;
  bidi: number;
}
export interface TextLine {
  text: string;
  bbox: Rect;
  direction: [number, number];
  chars: TextChar[];
}
export interface SearchHit {
  pageId: PageId;
  pageIndex: number;
  quads: Quad[];
}
export type EngineCallOptions = {
  signal?: AbortSignal;
  onProgress?: (data: unknown) => void;
  priority?: number;
};
export interface EngineClient {
  call<K extends keyof EngineOps>(method: K, args: EngineOps[K]['args'], options?: EngineCallOptions): Promise<EngineOps[K]['result']>;
  terminate(): void;
}
