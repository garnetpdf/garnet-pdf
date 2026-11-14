/** Page commands used by the grid, its menus, keyboard and the Organize toolbar. */
import type { PageId } from '../../../shared/engine-api';
import { useApp, type Tab } from '../../store';
import {
  copyPagesToClipboard,
  currentTab,
  insertFiles,
  notify,
  pageClipboard,
  pageOp,
  plural,
  refreshOutline,
  selectPages,
  targetPages,
} from './pageActions';
import { useOrganize } from './state';

function withTab<T>(fn: (tab: Tab) => Promise<T>): Promise<T | undefined> {
  const tab = currentTab();
  if (!tab) return Promise.resolve(undefined);
  return fn(tab);
}

export function rotatePages(delta: number, ids?: PageId[]): Promise<unknown> {
  return withTab(async (tab) => {
    const pageIds = ids ?? targetPages(tab);
    if (!pageIds.length) return;
    await pageOp('pages.rotate', { docId: tab.info.docId, pageIds, delta });
  });
}

export function deletePages(ids?: PageId[]): Promise<unknown> {
  return withTab(async (tab) => {
    const pageIds = ids ?? targetPages(tab);
    if (!pageIds.length) return;
    if (pageIds.length >= tab.info.pageCount) {
      notify('A document needs at least one page. Keep one page or extract the pages instead.');
      return;
    }
    const first = Math.min(...pageIds.map((id) => tab.info.pages.findIndex((p) => p.id === id)));
    const result = await pageOp('pages.delete', { docId: tab.info.docId, pageIds });
    if (!result) return;
    const next = result.pages[Math.min(first, result.pages.length - 1)];
    if (next) selectPages(tab.info.docId, [next.id]);
    void refreshOutline(tab.info.docId);
  });
}

export function duplicatePages(ids?: PageId[]): Promise<unknown> {
  return withTab(async (tab) => {
    const pageIds = ids ?? targetPages(tab);
    if (!pageIds.length) return;
    const result = await pageOp('pages.duplicate', { docId: tab.info.docId, pageIds });
    if (result?.inserted?.length) selectPages(tab.info.docId, result.inserted);
  });
}

export function reversePages(): Promise<unknown> {
  return withTab(async (tab) => {
    const selected = targetPages(tab);
    const pageIds = selected.length > 1 ? selected : undefined;
    await pageOp('pages.reverse', { docId: tab.info.docId, pageIds });
  });
}

/** Final order after moving `ids` before gap `before`; null when nothing would change. */
export function orderAfterMove(pages: readonly { id: PageId }[], ids: readonly PageId[], before: number): PageId[] | null {
  const moving = new Set(ids);
  const rest = pages.filter((p) => !moving.has(p.id)).map((p) => p.id);
  const insertAt = before - pages.slice(0, before).filter((p) => moving.has(p.id)).length;
  const order = [...rest.slice(0, insertAt), ...pages.filter((p) => moving.has(p.id)).map((p) => p.id), ...rest.slice(insertAt)];
  return order.every((id, i) => id === pages[i].id) ? null : order;
}

export async function movePages(docId: string, ids: PageId[], before: number): Promise<boolean> {
  const tab = useApp.getState().tabs.find((t) => t.info.docId === docId);
  if (!tab || !ids.length) return false;
  if (!orderAfterMove(tab.info.pages, ids, before)) return false;
  useOrganize.getState().startTiming();
  const result = await pageOp('pages.move', { docId, pageIds: ids, before });
  if (!result) {
    useOrganize.setState({ pendingSince: null });
    return false;
  }
  return true;
}

export function copyPages(ids?: PageId[]): Promise<unknown> {
  return withTab(async (tab) => {
    const pageIds = ids ?? targetPages(tab);
    if (pageIds.length && (await copyPagesToClipboard(tab, pageIds))) notify(`Copied ${plural(pageIds.length, 'page')}.`);
  });
}

export function cutPages(ids?: PageId[]): Promise<unknown> {
  return withTab(async (tab) => {
    const pageIds = ids ?? targetPages(tab);
    if (!pageIds.length) return;
    if (pageIds.length >= tab.info.pageCount) {
      notify('A document needs at least one page. Use Copy instead.');
      return;
    }
    if (await copyPagesToClipboard(tab, pageIds)) await deletePages(pageIds);
  });
}

/** Pastes copied pages before gap `at` (default: after the selection or current page). */
export function pastePages(at?: number): Promise<unknown> {
  return withTab(async (tab) => {
    const clip = pageClipboard();
    if (!clip) {
      notify('Copy or cut pages first.');
      return;
    }
    let where = at;
    if (where === undefined) {
      const ids = targetPages(tab);
      const last = Math.max(-1, ...ids.map((id) => tab.info.pages.findIndex((p) => p.id === id)));
      where = last + 1;
    }
    await insertFiles(tab.info.docId, where, [{ name: clip.name, bytes: clip.bytes }]);
  });
}

export async function insertBlankAt(at: number, count = 1): Promise<void> {
  const tab = currentTab();
  if (!tab) return;
  // Same visible size as the page before the gap (PageInfo sizes include /Rotate).
  const reference = tab.info.pages[Math.max(0, Math.min(at, tab.info.pages.length) - 1)] ?? tab.info.pages[0];
  const size: [number, number] = [Math.round(reference.width), Math.round(reference.height)];
  const result = await pageOp('pages.insertBlank', { docId: tab.info.docId, at, count, size });
  if (result?.inserted?.length) selectPages(tab.info.docId, result.inserted);
}

export function openInView(docId: string, index: number): void {
  const state = useApp.getState();
  state.updateTab(docId, { page: index });
  state.set({ mode: 'View' });
}
