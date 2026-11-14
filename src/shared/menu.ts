/**
 * The menu bar (a Mac has one at the top of the screen) and the window talk through these.
 * A menu item sends a command name to the window; the window reports what the menu should show.
 */

/** What the window reports, so that items can be greyed out and the current mode ticked. */
export interface MenuState {
  hasDocument: boolean;
  /** The mode shown in the window (View, Edit and so on). */
  mode: string;
  /** Every mode the window offers, in the order of its mode row. */
  modes: string[];
}

export const emptyMenuState: MenuState = { hasDocument: false, mode: '', modes: [] };

/**
 * Commands that are not plug-in commands. Any other name (for example `view.open`) is the id of a
 * command registered by a plug-in and is run as it is.
 */
export const menuCommand = {
  about: 'shell.about',
  closeTab: 'shell.closeTab',
  /** Undo and redo go to the text field when the cursor is in one, otherwise to the document. */
  undo: 'edit.undo',
  redo: 'edit.redo',
  zoom: (value: 'fit-width' | 'fit-page' | '1') => `shell.zoom:${value}`,
  mode: (mode: string) => `shell.mode:${mode}`,
} as const;

/** The only web address the menu ever opens, and only when its item is chosen. */
export const WEBSITE = 'https://garnetpdf.com';
