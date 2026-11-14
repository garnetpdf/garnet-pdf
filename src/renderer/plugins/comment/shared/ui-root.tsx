/**
 * A small React root owned by the annotation plugins for dialogs that must close themselves
 * (the host dialog API cannot). Uses the shell's Dialog component and theme tokens.
 */
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { Dialog } from '../../../ui';

interface Entry {
  id: number;
  title: string;
  render: (close: () => void) => ReactNode;
  wide?: boolean;
}
const useDialogs = create<{ entries: Entry[] }>(() => ({ entries: [] }));
let root: Root | null = null;
let container: HTMLElement | null = null;
let nextId = 1;

function Host() {
  const entries = useDialogs((s) => s.entries);
  return (
    <>
      {entries.map((entry) => {
        const close = () =>
          useDialogs.setState((s) => ({ entries: s.entries.filter((e) => e.id !== entry.id) }));
        return (
          <div key={entry.id} className={entry.wide ? 'annot-dialog wide' : 'annot-dialog'}>
            <Dialog title={entry.title} onClose={close}>
              {entry.render(close)}
            </Dialog>
          </div>
        );
      })}
    </>
  );
}

let users = 0;
function ensureRoot() {
  if (root) return;
  container = document.createElement('div');
  container.className = 'annot-dialog-root';
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<Host />);
}

/** Reference-counted: each plugin mounts on activation and releases on deactivation. */
export function mountDialogRoot(): () => void {
  users++;
  ensureRoot();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users > 0) return;
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
    useDialogs.setState({ entries: [] });
  };
}

/** Opens a dialog; `render` receives a close function. Resolves when the dialog closes. */
export function openDialog(
  title: string,
  render: (close: () => void) => ReactNode,
  options: { wide?: boolean } = {},
): Promise<void> {
  ensureRoot();
  return new Promise((resolve) => {
    const id = nextId++;
    const wrapped = (close: () => void) =>
      render(() => {
        close();
        resolve();
      });
    useDialogs.setState((s) => ({ entries: [...s.entries, { id, title, render: wrapped, wide: options.wide }] }));
    const off = useDialogs.subscribe((s) => {
      if (!s.entries.some((e) => e.id === id)) {
        off();
        resolve();
      }
    });
  });
}

export function dialogOpen(): boolean {
  return useDialogs.getState().entries.length > 0;
}
