import { Menu, type MenuItemConstructorOptions } from 'electron';
import { menuCommand, type MenuState } from '../shared/menu';

export interface MenuOptions {
  platform: NodeJS.Platform;
  /** True in an installed app. Developer items exist only when this is false. */
  packaged: boolean;
  appName: string;
  state: MenuState;
  /** Runs a command in the window, opening a window first when none is open. */
  send(command: string): void;
  /** Opens the website in the browser. Nothing else in the menu opens a link. */
  openWebsite(): void;
}

type Item = MenuItemConstructorOptions;
const separator: Item = { type: 'separator' };

/**
 * The application menu.
 *
 * On a Mac this is the menu bar at the top of the screen. On Windows and Linux the window has no menu
 * bar and none appears: an installed app only gets a short hidden menu that keeps the keys people
 * already use (Ctrl+W, Ctrl+M, F11) and leaves out the developer keys Electron adds by itself
 * (reload, developer tools, resizing the whole interface). When the app is run from source on Windows
 * or Linux this returns null and Electron's own menu stays, so developers keep those keys.
 */
export function menuTemplate(options: MenuOptions): Item[] | null {
  if (options.platform === 'darwin') return macMenu(options);
  return options.packaged ? hiddenMenu(options) : null;
}

function macMenu({ appName, packaged, state, send, openWebsite }: MenuOptions): Item[] {
  const item = (label: string, command: string, accelerator?: string, enabled = true): Item => ({
    label,
    accelerator,
    enabled,
    click: () => send(command),
  });
  const doc = state.hasDocument;
  const template: Item[] = [
    {
      label: appName,
      submenu: [
        item(`About ${appName}`, menuCommand.about),
        separator,
        item('Settings…', 'view.settings', 'Command+,'),
        separator,
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        separator,
        { role: 'quit', label: `Quit ${appName}` },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('Open…', 'view.open', 'Command+O'),
        {
          label: 'Open Recent',
          role: 'recentDocuments',
          submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }],
        },
        separator,
        item('Save', 'view.save', 'Command+S', doc),
        item('Save As…', 'view.saveAs', 'Shift+Command+S', doc),
        separator,
        item('Print…', 'view.print', 'Command+P', doc),
        separator,
        item('Close Tab', menuCommand.closeTab, 'Command+W'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', menuCommand.undo, 'Command+Z'),
        item('Redo', menuCommand.redo, 'Shift+Command+Z'),
        separator,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        separator,
        item('Find…', 'view.find', 'Command+F', doc),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Zoom In', 'view.zoomIn', 'Command+Plus', doc),
        // the plus key of a number pad: same command, not listed twice
        { ...item('Zoom In', 'view.zoomIn', 'Command+numadd', doc), visible: false },
        item('Zoom Out', 'view.zoomOut', 'Command+-', doc),
        item('Actual Size', menuCommand.zoom('1'), 'Command+0', doc),
        item('Fit Width', menuCommand.zoom('fit-width'), undefined, doc),
        item('Fit Page', menuCommand.zoom('fit-page'), undefined, doc),
        separator,
        ...state.modes.map((mode): Item => ({
          label: mode,
          type: 'radio',
          checked: mode === state.mode,
          click: () => send(menuCommand.mode(mode)),
        })),
        ...(state.modes.length ? [separator] : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'Minimise' },
        { role: 'zoom' },
        separator,
        { role: 'front', label: 'Bring All to Front' },
      ],
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [{ label: `${appName} website`, click: () => openWebsite() }],
    },
  ];
  if (!packaged)
    template.splice(template.length - 2, 0, {
      label: 'Develop',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
    });
  return template;
}

function hiddenMenu({ platform, send }: MenuOptions): Item[] {
  return [
    {
      label: 'File',
      submenu: [{ role: 'close' }, ...(platform === 'linux' ? [{ role: 'quit' } as Item] : [])],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        separator,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        separator,
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // "Ctrl and plus" used to make the whole interface bigger; it now zooms the page, like Ctrl+=.
        { label: 'Zoom in', accelerator: 'Control+Plus', click: () => send('view.zoomIn') },
        { label: 'Zoom in', accelerator: 'Control+numadd', click: () => send('view.zoomIn') },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }] },
  ];
}

/** Every item of a template with its place in the menu, for checks and tests. */
export function flattenMenu(template: Item[], path = ''): Array<Item & { path: string }> {
  return template.flatMap((entry) => {
    const here = `${path}${entry.label ?? entry.role ?? entry.type ?? ''}`;
    const below = Array.isArray(entry.submenu) ? flattenMenu(entry.submenu, `${here} > `) : [];
    return [{ ...entry, path: here }, ...below];
  });
}

/** Builds the menu and makes it the application menu. Does nothing where Electron's own menu stays. */
export function applyMenu(options: MenuOptions): void {
  const template = menuTemplate(options);
  if (template) Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
