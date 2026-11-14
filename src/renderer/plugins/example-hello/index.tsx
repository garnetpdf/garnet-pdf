import { useSyncExternalStore } from 'react';
import { RotateCw, Shapes } from 'lucide-react';
import {
  definePlugin,
  type EditPage,
  type PluginContext,
  type SelectionItem,
} from '../../plugin-host/types';
import { contains, transformRect } from '../../plugin-host/geometry';

export default definePlugin({
  id: 'example-hello',
  name: 'Example extension',
  version: '1.0.0',
  activate(ctx) {
    const disposers: Array<() => void> = [];
    let stop: (() => void) | undefined;
    let closed = false;
    const register = () => {
      disposers.push(
        ctx.commands.register({
          id: 'example.pageCount',
          title: 'Show page count',
          run: async () => {
            const doc = ctx.documents.active();
            if (doc) {
              const count = await ctx.engine.call('example.pageCount', { docId: doc.docId });
              ctx.ui.toast(`${count} pages in this document`);
            }
          },
        }),
        ctx.commands.register({
          id: 'example.rotate',
          title: 'Rotate page clockwise',
          icon: RotateCw,
          run: async () => {
            const doc = ctx.documents.active();
            if (doc)
              await ctx.engine.call('example.rotate', {
                docId: doc.docId,
                pageId: doc.pageId,
                degrees: 90,
              });
          },
        }),
        ctx.toolbar.addItem('Tools', {
          id: 'example.count',
          command: 'example.pageCount',
          label: 'Page count',
        }),
        ctx.toolbar.addItem('Tools', {
          id: 'example.rotate',
          command: 'example.rotate',
          label: 'Rotate page',
        }),
      );
      disposers.push(
        ctx.commands.register({
          id: 'example.testProvider',
          title: 'Toggle edit demonstration',
          icon: Shapes,
          run: () => {
            if (stop) {
              stop();
              stop = undefined;
              ctx.selection.set([]);
              ctx.ui.toast('Edit demonstration removed');
            } else {
              stop = registerDemo(ctx);
              ctx.ui.toast('Edit demonstration enabled. Switch to Edit to move the rectangles.');
            }
          },
        }),
        ctx.toolbar.addItem('Tools', {
          id: 'example.testProvider',
          command: 'example.testProvider',
          label: 'Edit demonstration',
        }),
      );
    };
    // A sample for extension authors and the test suite: kept out of the installed app.
    void Promise.resolve()
      .then(() => window.garnet.appInfo())
      .then(({ packaged }) => {
        if (!packaged && !closed) register();
      })
      .catch(() => undefined);
    return () => {
      closed = true;
      stop?.();
      disposers.forEach((d) => d());
    };
  },
});
function registerDemo(ctx: PluginContext) {
  const pages = new Map<string, SelectionItem[]>();
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => {
    version++;
    listeners.forEach((f) => f());
  };
  const get = (page: EditPage) => {
    if (!pages.has(`${page.docId}:${page.pageId}`))
      pages.set(`${page.docId}:${page.pageId}`, [
        {
          id: 'demo-a',
          providerId: 'example.rectangles',
          kind: 'demo',
          pageId: page.pageId,
          bounds: [70, 90, 200, 155],
        },
        {
          id: 'demo-b',
          providerId: 'example.rectangles',
          kind: 'demo',
          pageId: page.pageId,
          bounds: [260, 210, 390, 275],
        },
      ]);
    return pages.get(`${page.docId}:${page.pageId}`)!;
  };
  const set = (id: string, items: SelectionItem[]) => {
    pages.set(id, items);
    ctx.selection.set(
      ctx.selection
        .get()
        .map((s) => items.find((i) => i.id === s.id && i.providerId === s.providerId) || s),
    );
    emit();
  };
  function Overlay({ page }: { page: EditPage }) {
    useSyncExternalStore(
      (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      () => version,
    );
    return (
      <>
        {get(page).map((item) => {
          const b = transformRect(page.pageToView, item.bounds);
          const total = transformRect(page.pageToView, [0, 0, page.width, page.height]);
          return (
            <div
              className="dummy-rect"
              data-testid={item.id}
              key={item.id}
              style={{
                left: `${(b[0] / total[2]) * 100}%`,
                top: `${(b[1] / total[3]) * 100}%`,
                width: `${((b[2] - b[0]) / total[2]) * 100}%`,
                height: `${((b[3] - b[1]) / total[3]) * 100}%`,
              }}
            >
              Demo rectangle
            </div>
          );
        })}
      </>
    );
  }
  return ctx.edit.registerProvider({
    id: 'example.rectangles',
    kinds: ['demo'],
    hitTest: (page, pt) =>
      get(page)
        .filter((i) => contains(i.bounds, pt))
        .at(-1) || null,
    hoverCandidates: get,
    overlay: Overlay,
    onTransform: async (items, matrix, page) => {
      const before = get(page).map((s) => ({
        ...s,
        bounds: [...s.bounds] as SelectionItem['bounds'],
      }));
      const after = before.map((s) =>
        items.some((i) => i.id === s.id) ? { ...s, bounds: transformRect(matrix, s.bounds) } : s,
      );
      await ctx.history.run(
        'Transform demo rectangles',
        () => set(`${page.docId}:${page.pageId}`, after),
        {
          undo: () => set(`${page.docId}:${page.pageId}`, before),
          redo: () => set(`${page.docId}:${page.pageId}`, after),
        },
      );
    },
    onDelete: async (items, page) => {
      const before = [...get(page)],
        after = before.filter((s) => !items.some((i) => i.id === s.id));
      await ctx.history.run(
        'Delete demo rectangles',
        () => set(`${page.docId}:${page.pageId}`, after),
        {
          undo: () => set(`${page.docId}:${page.pageId}`, before),
          redo: () => set(`${page.docId}:${page.pageId}`, after),
        },
      );
    },
    contextMenu: () => [
      {
        id: 'demo.info',
        label: 'Demonstration only, PDF unchanged',
        run: () => ctx.ui.toast('These rectangles test the shared Edit host.'),
      },
    ],
  });
}
