import { Info } from 'lucide-react';
import { definePlugin } from '../../plugin-host/types';
import { BookmarksPanel } from './bookmarks';
import { AttachmentsPanel, LayersPanel } from './attachments';
import { showProperties } from './properties';
import { errorText } from '../protect/kit';

export default definePlugin({
  id: 'doc-panels',
  name: 'Document panels',
  version: '1.0.0',
  activate(ctx) {
    const Bookmarks = () => <BookmarksPanel ctx={ctx} />;
    const Attachments = () => <AttachmentsPanel ctx={ctx} />;
    const Layers = () => <LayersPanel ctx={ctx} />;
    const disposers = [
      ctx.panels.register('left', { id: 'Bookmarks', title: 'Bookmarks', component: Bookmarks }),
      ctx.panels.register('left', {
        id: 'Attachments',
        title: 'Attachments',
        component: Attachments,
      }),
      ctx.panels.register('left', { id: 'Layers', title: 'Layers', component: Layers }),
      ctx.commands.register({
        id: 'docPanels.properties',
        title: 'Document properties',
        shortcut: 'Alt+Enter',
        icon: Info,
        enabled: () => !!ctx.documents.active(),
        run: () => showProperties(ctx).catch((error) => ctx.ui.toast(errorText(error))),
      }),
      ctx.keybindings.register('Alt+Enter', 'docPanels.properties'),
      ctx.toolbar.addItem('Tools', {
        id: 'docPanels.properties',
        command: 'docPanels.properties',
        label: 'Properties',
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  },
});
