import {
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  Search,
  Printer,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Settings,
  Maximize,
  PanelLeft,
  Columns2,
  Hand,
  Presentation,
  SquareDashedMousePointer,
} from 'lucide-react';
import { definePlugin } from '../../plugin-host/types';
import { actions } from '../../actions';
export default definePlugin({
  id: 'view',
  name: 'View',
  version: '1.0.0',
  activate(ctx) {
    const modes = [
      'View',
      'Organize',
      'Edit',
      'Comment',
      'Fill & Sign',
      'Protect',
      'Tools',
    ] as const;
    modes.forEach((id) => ctx.modes.register({ id, label: id }));
    const commands = [
      ['open', 'Open files', 'Ctrl+O', FolderOpen],
      ['save', 'Save', 'Ctrl+S', Save],
      ['saveAs', 'Save As', 'Ctrl+Shift+S', Save],
      ['undo', 'Undo', 'Ctrl+Z', Undo2],
      ['redo', 'Redo', 'Ctrl+Shift+Z', Redo2],
      ['find', 'Find in document', 'Ctrl+F', Search],
      ['print', 'Print', 'Ctrl+P', Printer],
      ['zoomIn', 'Zoom in', 'Ctrl+=', ZoomIn],
      ['zoomOut', 'Zoom out', 'Ctrl+-', ZoomOut],
      ['rotateView', 'Rotate view', 'Ctrl+R', RotateCw],
      ['settings', 'Settings', 'Ctrl+,', Settings],
      ['fullscreen', 'Full screen', 'F11', Maximize],
      ['sidebar', 'Toggle sidebar', 'Ctrl+B', PanelLeft],
      ['layout', 'Change page layout', '', Columns2],
      ['hand', 'Hand tool', 'H', Hand],
      ['presentation', 'Presentation', 'F5', Presentation],
      ['marquee', 'Marquee zoom', 'Z', SquareDashedMousePointer],
    ] as const;
    for (const [id, title, shortcut, icon] of commands) {
      ctx.commands.register({
        id: `view.${id}`,
        title,
        shortcut,
        icon,
        run: async () => {
          await actions[id]?.();
        },
      });
      if (shortcut) ctx.keybindings.register(shortcut, `view.${id}`);
    }
    ctx.keybindings.register('Ctrl+Y', 'view.redo');
    for (const id of ['hand', 'rotateView', 'layout', 'find', 'presentation'])
      ctx.toolbar.addItem('View', { id: `view.${id}`, command: `view.${id}` });
  },
});
