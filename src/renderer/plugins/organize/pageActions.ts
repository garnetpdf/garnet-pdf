/**
 * Page actions shared by the Organize grid and the page tool dialogs. Everything goes through the
 * plugin context's engine client, so the shell updates the document state from each result.
 */
import type { EngineOps, PageId } from '../../../shared/engine-api';
import type { FileDescriptor } from '../../../shared/ipc';
import type { PluginContext } from '../../plugin-host/types';
import { activeTab, useApp, type Tab } from '../../store';
import { selectedInOrder, useOrganize } from './state';

let context: PluginContext | null = null;
export function setPageContext(ctx: PluginContext | null): void {
  context = ctx;
}
export function pageContext(): PluginContext {
  if (!context) throw new Error('The Organize tools are not ready.');
  return context;
}

/** Page operations jump ahead of thumbnail renders (priority 1) and page renders (80-150). */
const PRIORITY = 200;

export function friendlyError(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error).replace(/^(Error:\s*)+/, '');
  if (text.includes('NOTHING_TO_REMOVE')) return 'There is nothing to remove on these pages.';
  if (/password/i.test(text) && /PASSWORD/.test(text)) return 'This file is protected with a password.';
  return text || 'The pages could not be changed.';
}

export function isCancel(error: unknown): boolean {
  return /CANCELLED|AbortError|aborted/i.test(String(error));
}

export function notify(message: string): void {
  pageContext().ui.toast(message);
}

/** Runs one page operation. Errors are shown as a message and resolve to null. */
export async function pageOp<K extends keyof EngineOps>(
  method: K,
  args: EngineOps[K]['args'],
  options: { onProgress?: (data: unknown) => void; signal?: AbortSignal } = {},
): Promise<EngineOps[K]['result'] | null> {
  try {
    return await pageContext().engine.call(method, args, { priority: PRIORITY, ...options });
  } catch (error) {
    if (!isCancel(error)) notify(friendlyError(error));
    return null;
  }
}

/** Selected pages of the tab, or the current page when nothing is selected. */
export function targetPages(tab: Tab): PageId[] {
  const selected = selectedInOrder(tab.info.docId, tab.info.pages);
  if (selected.length) return selected;
  const current = tab.info.pages[tab.page];
  return current ? [current.id] : [];
}

export function selectPages(docId: string, ids: PageId[]): void {
  useOrganize.getState().select(docId, { ids, anchor: ids[0], focus: ids[ids.length - 1] });
}

/** Re-reads the bookmarks after operations that change them (delete, insert, replace...). */
export async function refreshOutline(docId: string): Promise<void> {
  try {
    const outline = await pageContext().engine.call('core.getOutline', { docId }, { priority: 120 });
    useApp.getState().updateInfo(docId, { outline });
  } catch {
    /* The bookmark panel keeps the previous list. */
  }
}

export function uniqueDocName(base: string): string {
  const stem = base.replace(/\.pdf$/i, '');
  const taken = new Set(useApp.getState().tabs.map((t) => t.file.name.toLowerCase()));
  let name = `${stem}.pdf`;
  for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${stem} (${k}).pdf`;
  return name;
}

/** Opens new document bytes (combined, extracted, N-up) in a new unsaved tab. */
export async function openAsNewTab(bytes: ArrayBuffer, name: string): Promise<boolean> {
  const ctx = pageContext();
  const size = bytes.byteLength;
  try {
    // core.open transfers the bytes to the engine; the size is read first.
    const info = await ctx.engine.call('core.open', { bytes, unsaved: true });
    const file: FileDescriptor = { handle: '', name: uniqueDocName(name), kind: 'pdf', size, lastModified: Date.now() };
    const state = useApp.getState();
    state.set({
      tabs: [...state.tabs, { info: { ...info, dirty: true }, file, page: 0, zoom: 1, rotation: 0, layout: 'continuous' }],
      activeId: info.docId,
      hits: [],
      query: '',
    });
    return true;
  } catch (error) {
    notify(friendlyError(error));
    return false;
  }
}

export interface PickedFile {
  name: string;
  bytes: ArrayBuffer;
  handle?: string;
}

/** Shows the system file picker and reads the chosen PDFs and images. */
export async function pickFiles(): Promise<PickedFile[]> {
  const files = await window.garnet.openDialog();
  const out: PickedFile[] = [];
  for (const file of files) {
    try {
      out.push({ name: file.name, bytes: await window.garnet.readFile(file.handle), handle: file.handle });
    } catch (error) {
      notify(`Could not read ${file.name}: ${friendlyError(error)}`);
    }
  }
  return out;
}

const ACCEPTED = /\.(pdf|png|jpe?g)$/i;
export async function readDroppedFiles(list: readonly File[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const skipped: string[] = [];
  for (const file of list) {
    if (!ACCEPTED.test(file.name) && !/^(application\/pdf|image\/(png|jpeg))$/.test(file.type)) {
      skipped.push(file.name);
      continue;
    }
    out.push({ name: file.name, bytes: await file.arrayBuffer() });
  }
  if (skipped.length) notify(`Only PDF, PNG and JPEG files can be added as pages (skipped ${skipped.join(', ')}).`);
  return out;
}

/** Inserts files (PDF pages or images) at a position, as one undo step. */
export async function insertFiles(docId: string, at: number, files: PickedFile[], options: { pages?: string; fitTo?: [number, number] } = {}): Promise<PageId[] | null> {
  if (!files.length) return null;
  const result = await pageOp('pages.insertFrom', {
    docId,
    at,
    sources: files.map((f) => ({ bytes: f.bytes.slice(0), name: f.name, pages: options.pages || undefined, fitTo: /\.pdf$/i.test(f.name) ? undefined : options.fitTo })),
  });
  if (!result) return null;
  const inserted = result.inserted ?? [];
  if (inserted.length) selectPages(docId, inserted);
  if (result.renamedFields?.length) notify(`${result.renamedFields.length} form field${result.renamedFields.length === 1 ? ' was' : 's were'} renamed to keep names unique.`);
  void refreshOutline(docId);
  return inserted;
}

/** Copies pages from one open document into another (through PDF bytes; each document has its own engine). */
export async function copyPagesTo(fromDocId: string, ids: PageId[], toDocId: string, at: number): Promise<number> {
  const extracted = await pageOp('pages.extract', { docId: fromDocId, pageIds: ids });
  const file = extracted?.files[0];
  if (!file) return 0;
  const inserted = await insertFiles(toDocId, at, [{ name: file.name, bytes: file.bytes }]);
  return inserted?.length ?? 0;
}

export function tabByDocId(docId: string): Tab | undefined {
  return useApp.getState().tabs.find((t) => t.info.docId === docId);
}

export function currentTab(): Tab | undefined {
  return activeTab();
}

export function baseName(tab: Tab): string {
  return tab.file.name.replace(/\.[^.]+$/, '');
}

/** Pages of a tab in one call: the selection, all pages, or a validated range. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Internal page clipboard (copy, cut, paste between and within documents). */
export interface PageClipboard {
  name: string;
  bytes: ArrayBuffer;
  count: number;
}
let clipboard: PageClipboard | null = null;
export async function copyPagesToClipboard(tab: Tab, ids: PageId[]): Promise<boolean> {
  const extracted = await pageOp('pages.extract', { docId: tab.info.docId, pageIds: ids, baseName: tab.file.name });
  const file = extracted?.files[0];
  if (!file) return false;
  clipboard = { name: file.name, bytes: file.bytes, count: ids.length };
  return true;
}
export function pageClipboard(): PageClipboard | null {
  return clipboard;
}
