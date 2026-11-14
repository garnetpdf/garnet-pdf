/** Small shared toolkit for the Protect, Reduce size, Export and Document panels plug-ins: a self-closing dialog host and form rows built on the UI kit. */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '../../ui';
import { useApp, type Tab } from '../../store';
import type { PluginContext } from '../../plugin-host/types';
import type { DocumentInfo, EngineClient } from '../../../shared/engine-api';
import { createEngineClient } from '../../../engine/client';
import './p4b.css';

/**
 * Runs work against a snapshot of the document in a separate, disposable engine worker, so long jobs never
 * touch the open document. `size` is the snapshot's byte length.
 */
export async function withIsolatedCopy<T>(
  ctx: PluginContext,
  docId: string,
  run: (client: EngineClient, copy: DocumentInfo, size: number) => Promise<T>,
): Promise<T> {
  const snapshot = await ctx.engine.call('core.snapshot', { docId });
  const size = snapshot.bytes.byteLength;
  const client = createEngineClient();
  try {
    const copy = await client.call('core.open', { bytes: snapshot.bytes });
    return await run(client, copy, size);
  } finally {
    client.terminate();
  }
}

/** Opens a dialog that can close itself with a value. Escape, the close button and the backdrop resolve undefined. */
export function openDialog<T>(
  title: string,
  render: (close: (value?: T) => void) => ReactNode,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let done = false;
    const close = (value?: T) => {
      if (done) return;
      done = true;
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(
      <Dialog title={title} onClose={() => close()}>
        {render(close)}
      </Dialog>,
    );
  });
}

export function tabFor(docId: string): Tab | undefined {
  return useApp.getState().tabs.find((tab) => tab.info.docId === docId);
}

/** Re-renders when the document's revision changes (edits, undo, redo). */
export function useRevision(docId: string | undefined): number {
  return useApp((state) => state.tabs.find((tab) => tab.info.docId === docId)?.info.revision ?? -1);
}

/** A labelled row. A group, not a <label>, so buttons inside keep their own names; controls carry aria-labels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="p4b-field" role="group" aria-labelledby={id}>
      <span id={id}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function Check({
  checked,
  onChange,
  label,
  help,
  count,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  help?: string;
  count?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label className={`p4b-check ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {help && <small>{help}</small>}
      </span>
      {count !== undefined && count}
    </label>
  );
}

export function Progress({
  label,
  done,
  total,
  onCancel,
}: {
  label: string;
  done: number;
  total: number;
  onCancel?: () => void;
}) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="p4b-progress" role="status" aria-live="polite">
      <div className="p4b-row">
        <span>{label}</span>
        <span className="p4b-count">{total > 0 ? `${done} of ${total}` : ''}</span>
      </div>
      <div className="p4b-bar" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </div>
      {onCancel && (
        <footer>
          <button onClick={onCancel}>Cancel</button>
        </footer>
      )}
    </div>
  );
}

/** Object URL for bytes, revoked when the component unmounts. */
export function useObjectUrl(bytes: ArrayBuffer | undefined, type: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!bytes) return;
    const next = URL.createObjectURL(new Blob([bytes], { type }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, type]);
  return url;
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error: /, '')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
