import { menuCommand } from '../shared/menu';

/** What the window offers to the commands of the menu bar. */
export interface MenuCommandDeps {
  /** True while a dialog is open. Keyboard shortcuts are ignored then, and so are menu commands. */
  dialogOpen(): boolean;
  /** The element that has the keyboard. */
  focused(): Element | null;
  hasCommand(id: string): boolean;
  execute(id: string): Promise<void>;
  /** Undo or redo inside the text field that has the keyboard (the system's own, not the document's). */
  textCommand(name: 'undo' | 'redo'): void;
  about(): void;
  /** Closes the document in front, or the window when no document is open. */
  closeTab(): Promise<void>;
  setZoom(value: string): void;
  setMode(mode: string): void;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

/** True for a place where typed text can be undone: a text input, a text area, an editable box. */
export function isTextField(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT')
    return TEXT_INPUT_TYPES.has(((element as HTMLInputElement).type || 'text').toLowerCase());
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * Runs a command chosen in the menu bar.
 *
 * Undo and Redo follow the keyboard: inside a text field they undo the typing (as the system does
 * everywhere), anywhere else they undo the last change to the document.
 */
export async function runMenuCommand(command: string, deps: MenuCommandDeps): Promise<void> {
  if (command === menuCommand.undo || command === menuCommand.redo) {
    const name = command === menuCommand.undo ? 'undo' : 'redo';
    if (isTextField(deps.focused())) deps.textCommand(name);
    else if (!deps.dialogOpen()) await deps.execute(`view.${name}`);
    return;
  }
  if (deps.dialogOpen()) return;
  if (command === menuCommand.about) deps.about();
  else if (command === menuCommand.closeTab) await deps.closeTab();
  else if (command.startsWith('shell.zoom:')) deps.setZoom(command.slice('shell.zoom:'.length));
  else if (command.startsWith('shell.mode:')) deps.setMode(command.slice('shell.mode:'.length));
  else if (deps.hasCommand(command)) await deps.execute(command);
}
