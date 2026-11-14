import { Crop, ImagePlus, Replace, SlidersHorizontal } from 'lucide-react';
import { definePlugin } from '../../plugin-host/types';
import { activeTab, useApp } from '../../store';
import { ObjectsController, kinds, providerId } from './controller';
import { hitObject, isBackground } from './geometry';
import { Inspector, ObjectActions } from './inspector';
import { ObjectOverlay } from './overlay';
import './objects.css';

export default definePlugin({
  id: providerId,
  name: 'Edit objects and images',
  version: '1.0.0',
  activate(ctx) {
    const c = new ObjectsController(ctx);
    const dispose = [
      useApp.subscribe((state, previous) => {
        if (
          state.activeId !== previous.activeId ||
          (state.mode !== 'Edit' && previous.mode === 'Edit')
        ) {
          c.cancelCrop();
          c.pasteTarget = null;
        }
      }),
      ctx.selection.subscribe(() => c.emit()),
      ctx.documents.subscribe('changed', (doc) => {
        c.invalidate(doc.docId);
        void c.reconcile(doc.docId).catch((error) => ctx.ui.toast(String(error)));
      }),
      ctx.documents.subscribe('closed', (doc) => {
        c.invalidate(doc.docId);
        c.cancelCrop();
      }),
    ];
    ctx.edit.registerProvider({
      id: providerId,
      kinds,
      hitTest: async (page, point) =>
        hitObject(await c.items(page), point, page, ((activeTab()?.zoom ?? 1) * 96) / 72, c.alt),
      hoverCandidates: async (page) =>
        (await c.items(page)).filter(
          (item) => c.alt || item.kind !== 'path' || !isBackground(item.bounds, page),
        ),
      onActivate: () => {
        useApp.getState().set({ inspector: true });
        c.allUses = false;
        c.emit();
      },
      onTransform: (items, matrix, page) => c.transform(items, matrix, page),
      onDelete: async (items, page) => {
        await c.edit({ type: 'delete', ids: items.map((s) => s.id) }, page);
      },
      overlay: ({ page }) => <ObjectOverlay controller={c} page={page} />,
    });
    for (const kind of kinds)
      ctx.inspector.register(kind, ({ selection }) => (
        <Inspector controller={c} selection={selection} />
      ));
    const entries = [
      {
        id: 'add',
        title: 'Add image',
        icon: ImagePlus,
        run: () => c.add(),
        enabled: () => !!ctx.documents.active() && !c.crop,
      },
      {
        id: 'replace',
        title: 'Replace image',
        icon: Replace,
        run: () => c.replace(),
        enabled: () => c.own().length === 1 && !c.reason('replace'),
      },
      {
        id: 'crop',
        title: 'Crop image',
        icon: Crop,
        run: () => c.beginCrop(),
        enabled: () => c.own().length === 1 && !c.reason('crop'),
      },
      {
        id: 'actions',
        title: 'Object actions',
        icon: SlidersHorizontal,
        run: () => ctx.ui.dialog(<ObjectActions controller={c} />, 'Object actions'),
        enabled: () => c.own().length > 0,
      },
    ];
    for (const entry of entries) {
      ctx.commands.register({
        ...entry,
        id: `objects.${entry.id}`,
        run: async () => {
          if (entry.id === 'actions') await entry.run();
          else await c.run(entry.run);
        },
      });
      ctx.toolbar.addItem('Edit', {
        id: `objects.${entry.id}`,
        command: `objects.${entry.id}`,
        label: entry.title,
      });
    }
    const paste = (e: ClipboardEvent) => {
      if (
        useApp.getState().mode !== 'Edit' ||
        (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable=true]'))
      )
        return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        /^image\/(png|jpeg)$/.test(f.type),
      );
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void c.run(async () => c.paste(await file.arrayBuffer()));
    };
    const alt = (e: KeyboardEvent) => {
      if (e.key === 'Escape') c.pasteTarget = null;
      if (c.alt !== e.altKey) {
        c.alt = e.altKey;
        c.emit();
      }
    };
    window.addEventListener('paste', paste, true);
    window.addEventListener('keydown', alt, true);
    window.addEventListener('keyup', alt, true);
    return () => {
      dispose.forEach((fn) => fn());
      window.removeEventListener('paste', paste, true);
      window.removeEventListener('keydown', alt, true);
      window.removeEventListener('keyup', alt, true);
    };
  },
});
