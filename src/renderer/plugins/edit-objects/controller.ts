import type { InspectObject, InspectResult, ObjectsEditAction } from '../../../engine/ops/objects';
import type {
  EditPage,
  Matrix,
  PluginContext,
  Point,
  Rect,
  SelectionItem,
} from '../../plugin-host/types';
import { activeTab, useApp } from '../../store';
import { viewMatrix } from '../../plugin-host/geometry';
import {
  about,
  alignment,
  bounds,
  hostToUserMatrix,
  inverse,
  placement,
  transformRect,
  userToHost,
  type Alignment,
} from './geometry';
export const providerId = 'edit-objects';
export const kinds = ['image', 'inline-image', 'path', 'form', 'shading'] as const;
export type ObjectData = { object: InspectObject; userToPage: Matrix; hitBounds?: Rect };
export type CropState = { page: EditPage; item: SelectionItem; rect: Rect };
export class ObjectsController {
  private cache = new Map<string, Promise<InspectResult>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private pendingEdits = 0;
  contentVersion = 0;
  crop: CropState | null = null;
  alt = false;
  fit: 'contain' | 'cover' | 'stretch' = 'contain';
  allUses = false;
  pasteTarget: { docId: string; id: string } | null = null;
  busy = false;
  constructor(readonly ctx: PluginContext) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  emit = () => {
    this.version++;
    this.listeners.forEach((fn) => fn());
  };
  invalidate(docId?: string) {
    this.contentVersion++;
    for (const key of this.cache.keys())
      if (!docId || key.startsWith(docId + ':')) this.cache.delete(key);
    this.emit();
  }
  own() {
    return this.ctx.selection.get().filter((s) => s.providerId === providerId);
  }
  page(): EditPage | null {
    const tab = activeTab();
    if (!tab) return null;
    const selected = this.own()[0];
    const p = tab.info.pages.find((p) => p.id === selected?.pageId) ?? tab.info.pages[tab.page];
    if (!p) return null;
    const rotated = p.rotation % 180 !== 0,
      width = rotated ? p.height : p.width,
      height = rotated ? p.width : p.height;
    const m = viewMatrix(width, height, p.rotation);
    return {
      docId: tab.info.docId,
      pageId: p.id,
      width,
      height,
      rotation: p.rotation,
      viewRotation: tab.rotation,
      pageToView: m,
      viewToPage: inverse(m),
    };
  }
  inspect(page: EditPage): Promise<InspectResult> {
    const revision =
      useApp.getState().tabs.find((t) => t.info.docId === page.docId)?.info.revision ?? 0;
    const key = `${page.docId}:${page.pageId}:${revision}`;
    let value = this.cache.get(key);
    if (!value) {
      value = this.ctx.engine.call('objects.inspect', { docId: page.docId, pageId: page.pageId });
      this.cache.set(key, value);
      value.catch(() => this.cache.delete(key));
    }
    return value;
  }
  async items(page: EditPage): Promise<SelectionItem[]> {
    const model = await this.inspect(page);
    return model.objects
      .filter((o) => kinds.includes(o.kind as (typeof kinds)[number]))
      .map((object) => ({
        id: object.id,
        providerId,
        kind: object.kind,
        pageId: page.pageId,
        bounds: transformRect(userToHost(page, model.userToPage), object.bbox),
        data: {
          object,
          userToPage: model.userToPage,
          hitBounds: transformRect(
            userToHost(page, model.userToPage),
            object.clipBBox ?? object.bbox,
          ),
        } satisfies ObjectData,
      }));
  }
  async reconcile(docId: string) {
    if (this.pendingEdits) return;
    const page = this.page();
    if (!page || page.docId !== docId) return;
    const selected = this.own().filter((item) => item.pageId === page.pageId);
    if (!selected.length) return;
    const signature = selected.map((item) => item.id).join('|');
    const items = await this.items(page);
    if (
      this.page()?.docId !== docId ||
      this.own()
        .filter((item) => item.pageId === page.pageId)
        .map((item) => item.id)
        .join('|') !== signature
    )
      return;
    const ids = new Set(selected.map((item) => item.id));
    this.ctx.selection.set([
      ...this.ctx.selection
        .get()
        .filter((item) => item.providerId !== providerId || item.pageId !== page.pageId),
      ...items.filter((item) => ids.has(item.id)),
    ]);
  }
  async edit(action: ObjectsEditAction, page = this.page()) {
    if (!page) return;
    this.pendingEdits++;
    try {
      const result = await this.ctx.engine.call('objects.edit', {
        docId: page.docId,
        pageId: page.pageId,
        action,
      });
      this.invalidate(page.docId);
      const ids = new Set(result.selectedIds);
      const selection = (await this.items(page)).filter((s) => ids.has(s.id));
      this.ctx.selection.set([
        ...this.ctx.selection.get().filter((s) => s.providerId !== providerId),
        ...selection,
      ]);
      return result;
    } finally {
      this.pendingEdits--;
    }
  }

  async transform(items: SelectionItem[], matrix: Matrix, page: EditPage) {
    const data = items[0]?.data as ObjectData | undefined;
    if (!data) return;
    await this.edit(
      {
        type: 'transform',
        ids: items.map((s) => s.id),
        matrix: hostToUserMatrix(page, data.userToPage, matrix),
      },
      page,
    );
  }
  async rotate(degrees: number, flip?: 'horizontal' | 'vertical') {
    const page = this.page(),
      items = this.own();
    if (!page || !items.length) return;
    await this.transform(items, about(bounds(items.map((s) => s.bounds)), degrees, flip), page);
  }
  async align(mode: Alignment) {
    const page = this.page(),
      items = this.own();
    if (!page || items.length < 2) return;
    const data = items[0].data as ObjectData;
    await this.edit(
      {
        type: 'transformMany',
        transforms: alignment(items, mode).map((t) => ({
          ...t,
          matrix: hostToUserMatrix(page, data.userToPage, t.matrix),
        })),
      },
      page,
    );
  }
  async fileBytes(): Promise<ArrayBuffer | null> {
    const files = await window.garnet.openDialog();
    if (!files.length) return null;
    const file = files.find((f) => f.kind === 'image');
    if (!file) throw new Error('Choose a PNG or JPEG image.');
    return window.garnet.readFile(file.handle);
  }
  async replace(bytes?: ArrayBuffer) {
    const item = this.own()[0];
    if (!item) return;
    const input = bytes ?? (await this.fileBytes());
    if (!input) return;
    // Capture selection before the chooser; changing document while open must not target a new object.
    const page = this.page();
    if (!page || !this.own().some((s) => s.id === item.id))
      throw new Error('Select the image again.');
    await this.edit(
      { type: 'replace', id: item.id, bytes: input, fit: this.fit, allUses: this.allUses },
      page,
    );
  }
  async clipboard(replace = false) {
    const item = this.own()[0],
      page = this.page();
    this.pasteTarget = replace && item && page ? { docId: page.docId, id: item.id } : null;
    this.ctx.ui.toast(
      replace
        ? 'Press Ctrl+V to replace this image. Escape cancels.'
        : 'Press Ctrl+V to add the clipboard image.',
    );
  }
  async paste(bytes: ArrayBuffer) {
    const target = this.pasteTarget;
    this.pasteTarget = null;
    if (target) {
      if (this.page()?.docId !== target.docId || this.own()[0]?.id !== target.id)
        throw new Error('The selection changed. Choose Replace from clipboard again.');
      await this.replace(bytes);
    } else await this.add(bytes);
  }
  async add(bytes?: ArrayBuffer, point?: Point, page = this.page()) {
    if (!page) return;
    const input = bytes ?? (await this.fileBytes());
    if (!input) return;
    const bitmap = await createImageBitmap(new Blob([input]));
    let rect: Rect;
    try {
      rect = placement(bitmap.width, bitmap.height, [0, 0, page.width, page.height], point);
    } finally {
      bitmap.close();
    }
    const model = await this.inspect(page);
    await this.edit(
      {
        type: 'insert',
        bytes: input,
        rect: transformRect(inverse(userToHost(page, model.userToPage)), rect),
      },
      page,
    );
    useApp.getState().set({ inspector: true });
  }
  beginCrop() {
    const page = this.page(),
      item = this.own()[0];
    if (!page || !item) return;
    const visible = (item.data as ObjectData).hitBounds ?? item.bounds;
    this.crop = { page, item: { ...item, bounds: visible }, rect: [...visible] };
    this.emit();
  }
  cancelCrop() {
    this.crop = null;
    this.emit();
  }
  async applyCrop() {
    const crop = this.crop;
    if (!crop) return;
    const data = crop.item.data as ObjectData;
    const rect = transformRect(inverse(userToHost(crop.page, data.userToPage)), crop.rect);
    await this.edit({ type: 'crop', id: crop.item.id, clip: rect }, crop.page);
    this.cancelCrop();
  }
  async extract() {
    const item = this.own()[0],
      page = this.page();
    if (!item || !page) return;
    const result = await this.ctx.engine.call('objects.extract', {
      docId: page.docId,
      pageId: page.pageId,
      id: item.id,
    });
    const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async run(fn: () => void | Promise<unknown>) {
    if (this.busy) return;
    this.busy = true;
    this.emit();
    try {
      await fn();
    } catch (error) {
      this.ctx.ui.toast(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.emit();
    }
  }
  reason(
    capability: keyof InspectObject['editability'] | 'extract' | 'editForm' | 'strokeWidth',
    items = this.own(),
  ): string | undefined {
    if (!items.length) return 'Select an object first.';
    if (this.busy) return 'Finish the current edit first.';
    if (this.crop) return 'Apply or cancel the crop first.';
    if (capability === 'editForm') {
      if (items.length !== 1 || items[0].kind !== 'form') return 'Select one form.';
      const object = (items[0].data as ObjectData).object;
      return object.editForm?.enabled && object.editability.move
        ? undefined
        : (object.editForm?.reason ??
            object.editability.reason ??
            'This form cannot be expanded safely.');
    }
    if (capability === 'strokeWidth') {
      if (items.some((s) => s.kind !== 'path' || !(s.data as ObjectData).object.paint?.stroke))
        return 'Select a stroked vector path.';
      return this.reason('recolor', items);
    }
    if (capability === 'extract')
      return items.length === 1 && items[0].kind === 'image'
        ? undefined
        : 'Select one image XObject to extract.';
    const item = items.find((s) => !(s.data as ObjectData).object.editability[capability]);
    return item
      ? ((item.data as ObjectData).object.editability.reason ??
          'This operation is unsafe for this object.')
      : undefined;
  }
}
