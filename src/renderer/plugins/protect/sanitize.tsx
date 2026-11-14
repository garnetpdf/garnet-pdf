import { useEffect, useState } from 'react';
import type { PluginContext } from '../../plugin-host/types';
import { redactionPending } from '../../actions';
import {
  SANITIZE_KEYS,
  SANITIZE_LABELS,
  type SanitizeCounts,
  type SanitizeOptions,
} from '../../../engine/tools/security/sanitize';
import { Check, errorText, openDialog, plural } from './kit';
import { thumbnailRefresh } from './redact';

const DEFAULTS: SanitizeOptions = {
  metadata: true,
  javascript: true,
  embeddedFiles: true,
  hiddenLayers: true,
  annotations: false,
  formActions: true,
  links: false,
  thumbnails: true,
};
const ALL = Object.fromEntries(SANITIZE_KEYS.map((key) => [key, true])) as SanitizeOptions;

function SanitizeForm({
  ctx,
  docId,
  close,
}: {
  ctx: PluginContext;
  docId: string;
  close: (value?: boolean) => void;
}) {
  const [counts, setCounts] = useState<SanitizeCounts | null>(null);
  const [options, setOptions] = useState<SanitizeOptions>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    ctx.engine
      .call('security.sanitizeScan', { docId, options: ALL })
      .then(setCounts, (cause) => setError(errorText(cause)));
  }, []);
  const selected = SANITIZE_KEYS.filter((key) => options[key] && (counts?.[key] ?? 0) > 0);
  const total = selected.reduce((sum, key) => sum + (counts?.[key] ?? 0), 0);
  const run = async () => {
    setBusy(true);
    try {
      const outcome = await ctx.engine.call('security.sanitize', { docId, options });
      if (!outcome.changed) return setError('Nothing was found to remove.');
      const removed = outcome.counts;
      redactionPending.add(docId);
      thumbnailRefresh.add(docId);
      const count = Object.values(removed).reduce((sum, value) => sum + value, 0);
      ctx.ui.toast(
        `Removed ${plural(count, 'item')} of hidden information. Save to make it permanent.`,
      );
      close(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="p4b-form" data-testid="sanitize-dialog">
      <p className="p4b-hint">
        Removes information that is not visible on the pages. Choose what to remove.
      </p>
      <section className="p4b-section" role="group" aria-label="Information to remove">
        {SANITIZE_KEYS.map((key) => {
          const found = counts?.[key] ?? 0;
          return (
            <Check
              key={key}
              checked={options[key]}
              onChange={(value) => setOptions({ ...options, [key]: value })}
              label={SANITIZE_LABELS[key].label}
              help={SANITIZE_LABELS[key].help}
              testId={`sanitize-${key}`}
              count={
                <span className={`p4b-count ${found ? 'found' : ''}`}>
                  {counts === null ? 'Checking' : found ? `${found} found` : 'None found'}
                </span>
              }
            />
          );
        })}
      </section>
      <p className="p4b-notice">
        After you save, undo history and recovery copies are cleared so the removed information
        cannot be brought back.
      </p>
      {error && (
        <p className="p4b-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={() => close()}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !total}
          onClick={() => void run()}
        >
          {total ? `Remove ${plural(total, 'item')}` : 'Nothing to remove'}
        </button>
      </footer>
    </div>
  );
}

export async function sanitizeDocument(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  await openDialog<boolean>('Sanitize document', (close) => (
    <SanitizeForm ctx={ctx} docId={doc.docId} close={close} />
  ));
}
