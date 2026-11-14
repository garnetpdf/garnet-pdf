import { createRoot } from 'react-dom/client';
import {
  ArrowDownUp,
  Crop,
  Ellipsis,
  FileMinus2,
  FileOutput,
  FilePlus2,
  FileSearch,
  Grid2x2,
  PaintBucket,
  PanelTop,
  Replace,
  Scaling,
  Scissors,
  Shuffle,
  Square,
  Stamp,
  Tag,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { definePlugin, type PluginContext } from '../../plugin-host/types';
import { ContextMenu } from '../../ui';
import { useApp } from '../../store';
import { requestTool, useToolRequest, type ToolKind } from '../organize/requests';
import { pageOp, notify, currentTab } from '../organize/pageActions';
import { reversePages } from '../organize/commands';
import { BlankPagesDialog, CombineDialog, DeletePagesDialog, ExtractDialog, InsertDialog, ReplaceDialog, SplitDialog, type DialogProps } from './dialogs/structure';
import { CropDialog, NupDialog, PageSizeDialog } from './dialogs/geometry';
import { BackgroundDialog, HeaderFooterDialog, WatermarkDialog } from './dialogs/stamps';
import { LabelsDialog } from './dialogs/labels';
import './page-tools.css';

const DIALOGS: Partial<Record<ToolKind, ComponentType<DialogProps>>> = {
  insert: InsertDialog,
  insertBlank: (props) => <InsertDialog {...props} blank />,
  extract: ExtractDialog,
  split: SplitDialog,
  delete: DeletePagesDialog,
  replace: ReplaceDialog,
  crop: CropDialog,
  pageSize: PageSizeDialog,
  nup: NupDialog,
  headerFooter: HeaderFooterDialog,
  watermark: WatermarkDialog,
  background: BackgroundDialog,
  labels: LabelsDialog,
  blank: BlankPagesDialog,
};

async function interleave(): Promise<void> {
  const tab = currentTab();
  if (!tab) return;
  if (tab.info.pageCount < 3) {
    notify('Collating needs at least three pages.');
    return;
  }
  const result = await pageOp('pages.interleave', { docId: tab.info.docId, backReversed: true });
  if (result) notify('Pages collated: the second half (back sides, last first) now follows each front page.');
}

const MORE: [string, ComponentType<{ size?: number }>, () => void][] = [
  ['Insert blank pages…', Square, () => requestTool('insertBlank')],
  ['Replace pages…', Replace, () => requestTool('replace')],
  ['Delete pages…', FileMinus2, () => requestTool('delete')],
  ['Page size…', Scaling, () => requestTool('pageSize')],
  ['Pages per sheet…', Grid2x2, () => requestTool('nup')],
  ['Background…', PaintBucket, () => requestTool('background')],
  ['Page labels…', Tag, () => requestTool('labels')],
  ['Find blank pages…', FileSearch, () => requestTool('blank')],
  ['Reverse page order', ArrowDownUp, () => void reversePages()],
  ['Collate scanned sides', Shuffle, () => void interleave()],
];

function DialogHost() {
  const request = useToolRequest((s) => s.request);
  const tab = useApp((s) => s.tabs.find((t) => t.info.docId === s.activeId));
  const close = () => useToolRequest.getState().set(null);
  if (!request) return null;
  if (request.kind === 'combine') return <CombineDialog key={request.seq} tab={tab} close={close} />;
  if (request.kind === 'more')
    return (
      <ContextMenu x={request.x ?? 200} y={request.y ?? 120} onClose={close}>
        {MORE.map(([label, Icon, run]) => (
          <button
            key={label}
            role="menuitem"
            disabled={!tab}
            onClick={() => {
              close();
              run();
            }}
          >
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </ContextMenu>
    );
  const Component = DIALOGS[request.kind];
  if (!Component || !tab) return null;
  return <Component key={`${request.seq}:${tab.info.docId}`} tab={tab} close={close} at={request.at} />;
}

function registerTools(ctx: PluginContext): void {
  const needsDoc = () => Boolean(ctx.documents.active());
  const tools: [string, string, ComponentType<{ size?: number }>, ToolKind][] = [
    ['pageTools.insert', 'Insert pages', FilePlus2, 'insert'],
    ['pageTools.extract', 'Extract pages', FileOutput, 'extract'],
    ['pageTools.split', 'Split document', Scissors, 'split'],
    ['pageTools.crop', 'Crop pages', Crop, 'crop'],
    ['pageTools.headerFooter', 'Header and footer', PanelTop, 'headerFooter'],
    ['pageTools.watermark', 'Watermark', Stamp, 'watermark'],
    ['pageTools.background', 'Background', PaintBucket, 'background'],
    ['pageTools.pageSize', 'Page size', Scaling, 'pageSize'],
    ['pageTools.nup', 'Pages per sheet', Grid2x2, 'nup'],
    ['pageTools.labels', 'Page labels', Tag, 'labels'],
    ['pageTools.replace', 'Replace pages', Replace, 'replace'],
    ['pageTools.deletePages', 'Delete pages', FileMinus2, 'delete'],
    ['pageTools.blank', 'Find blank pages', FileSearch, 'blank'],
  ];
  for (const [id, title, icon, kind] of tools) ctx.commands.register({ id, title, icon, enabled: needsDoc, run: () => requestTool(kind) });
  ctx.commands.register({
    id: 'pageTools.more',
    title: 'More page tools',
    icon: Ellipsis,
    enabled: needsDoc,
    run: () => {
      const button = document.querySelector<HTMLElement>('.context-toolbar [title^="More page tools"]');
      const r = button?.getBoundingClientRect();
      requestTool('more', { x: r ? r.left : 200, y: r ? r.bottom + 4 : 120 });
    },
  });
  ctx.commands.register({ id: 'pageTools.interleave', title: 'Collate scanned sides', icon: Shuffle, enabled: needsDoc, run: () => interleave() });
  const toolbar: [string, string][] = [
    ['pageTools.insert', 'Insert'],
    ['pageTools.extract', 'Extract'],
    ['pageTools.split', 'Split'],
    ['organize.rotateLeft', 'Rotate left'],
    ['organize.rotateRight', 'Rotate right'],
    ['organize.delete', 'Delete'],
    ['pageTools.crop', 'Crop'],
    ['pageTools.headerFooter', 'Header & footer'],
    ['pageTools.watermark', 'Watermark'],
    ['pageTools.more', 'More'],
  ];
  for (const [command, label] of toolbar) ctx.toolbar.addItem('Organize', { id: `organize-bar.${command}`, command, label });
}

export default definePlugin({
  id: 'page-tools',
  name: 'Page tools',
  version: '1.0.0',
  activate(ctx) {
    registerTools(ctx);
    const container = document.createElement('div');
    container.className = 'page-tools-root';
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(<DialogHost />);
    return () => {
      root.unmount();
      container.remove();
    };
  },
});
