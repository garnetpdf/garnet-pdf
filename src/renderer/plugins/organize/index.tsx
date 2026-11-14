import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Combine, CopyPlus, FilePlus2, RotateCcw, RotateCw, Trash2, ArrowDownUp } from 'lucide-react';
import { definePlugin } from '../../plugin-host/types';
import { useApp } from '../../store';
import { OrganizeGrid } from './Grid';
import { deletePages, duplicatePages, reversePages, rotatePages } from './commands';
import { refreshOutline, setPageContext } from './pageActions';
import { requestTool } from './requests';
import { useOrganize } from './state';
import './organize.css';

/** The viewer area of the shell, where the grid is shown while the Organize mode is on. */
function useViewerContainer(active: boolean): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) {
      setElement(null);
      return;
    }
    const find = () => setElement((previous) => document.querySelector<HTMLElement>('.viewer-container') ?? previous);
    find();
    const observer = new MutationObserver(() => {
      const next = document.querySelector<HTMLElement>('.viewer-container');
      setElement((previous) => (next === previous ? previous : next));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!element) return;
    element.classList.add('organize-active');
    return () => element.classList.remove('organize-active');
  }, [element]);
  return element;
}

function OrganizeRoot() {
  const mode = useApp((s) => s.mode);
  const tab = useApp((s) => s.tabs.find((t) => t.info.docId === s.activeId));
  const docIds = useApp((s) => s.tabs.map((t) => t.info.docId).join('|'));
  const container = useViewerContainer(mode === 'Organize' && Boolean(tab));
  const docId = tab?.info.docId;
  const revision = tab?.info.revision;
  useEffect(() => {
    // Keeps the bookmark panel right after page changes, including undo and redo.
    if (docId && revision) void refreshOutline(docId);
  }, [docId, revision]);
  useEffect(() => {
    const open = new Set(docIds.split('|'));
    const state = useOrganize.getState();
    const prune = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => open.has(id)));
    useOrganize.setState({ selection: prune(state.selection), fingerprints: prune(state.fingerprints) });
  }, [docIds]);
  if (mode !== 'Organize' || !tab || !container) return null;
  return createPortal(<OrganizeGrid key={tab.info.docId} tab={tab} />, container);
}

export default definePlugin({
  id: 'organize',
  name: 'Organize pages',
  version: '1.0.0',
  activate(ctx) {
    setPageContext(ctx);
    const commands = [
      { id: 'organize.rotateLeft', title: 'Rotate pages counterclockwise', icon: RotateCcw, run: () => rotatePages(-90) },
      { id: 'organize.rotateRight', title: 'Rotate pages clockwise', icon: RotateCw, run: () => rotatePages(90) },
      { id: 'organize.delete', title: 'Delete selected pages', icon: Trash2, run: () => deletePages() },
      { id: 'organize.duplicate', title: 'Duplicate pages', icon: CopyPlus, run: () => duplicatePages() },
      { id: 'organize.reverse', title: 'Reverse page order', icon: ArrowDownUp, run: () => reversePages() },
      { id: 'organize.insert', title: 'Insert pages from a file', icon: FilePlus2, run: () => requestTool('insert') },
      { id: 'organize.combine', title: 'Combine files', icon: Combine, run: () => requestTool('combine') },
    ];
    for (const command of commands) {
      const needsDocument = command.id !== 'organize.combine';
      ctx.commands.register({
        ...command,
        enabled: needsDocument ? () => Boolean(ctx.documents.active()) : undefined,
        run: async () => {
          await command.run();
        },
      });
    }
    const container = document.createElement('div');
    container.className = 'organize-root';
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(<OrganizeRoot />);
    return () => {
      root.unmount();
      container.remove();
      setPageContext(null);
    };
  },
});
