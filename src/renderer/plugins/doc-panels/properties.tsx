import { useEffect, useState } from 'react';
import type { PluginContext } from '../../plugin-host/types';
import type { DocumentProperties, EditableProperties } from '../../../engine/ops/metadata';
import type { SecurityStatus } from '../../../engine/ops/security';
import { PERMISSION_KEYS, PERMISSION_LABELS } from '../../../engine/tools/security/permissions';
import { formatBytes } from '../../../engine/tools/optimize/presets';
import { errorText, openDialog, plural, tabFor } from '../protect/kit';

const NAMED_SIZES: [string, number, number][] = [
  ['A3', 841.89, 1190.55],
  ['A4', 595.28, 841.89],
  ['A5', 419.53, 595.28],
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
];

export function pageSizeText(width: number, height: number): string {
  const mm = (points: number) => Math.round((points * 25.4) / 72);
  const [short, long] = width < height ? [width, height] : [height, width];
  const named = NAMED_SIZES.find(
    ([, w, h]) => Math.abs(w - short) < 2.5 && Math.abs(h - long) < 2.5,
  )?.[0];
  return `${mm(width)} × ${mm(height)} mm${named ? ` (${named}${width > height ? ', landscape' : ''})` : ''}`;
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}

function securityText(status: SecurityStatus): string {
  if (!status.encrypted) return 'No password';
  const method =
    status.method === 'aes-256'
      ? 'AES 256-bit'
      : status.method === 'aes-128'
        ? 'AES 128-bit'
        : status.method === 'rc4-128'
          ? 'RC4 128-bit (old)'
          : 'RC4 40-bit (old)';
  const blocked = PERMISSION_KEYS.filter((key) => !status.permissions[key]).map((key) =>
    PERMISSION_LABELS[key].toLowerCase(),
  );
  return `Password protected, ${method}. ${blocked.length ? `Not allowed: ${blocked.join(', ')}.` : 'No restrictions.'}`;
}

function PropertiesForm({
  ctx,
  docId,
  close,
}: {
  ctx: PluginContext;
  docId: string;
  close: () => void;
}) {
  const tab = tabFor(docId)!;
  const [props, setProps] = useState<DocumentProperties | null>(null);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [fields, setFields] = useState<EditableProperties>({
    title: '',
    author: '',
    subject: '',
    keywords: '',
  });
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([
      ctx.engine.call('metadata.get', { docId, pageIndex: tab.page }),
      ctx.engine.call('security.status', { docId }),
    ]).then(
      ([loaded, status]) => {
        setProps(loaded);
        setSecurity(status);
        setFields({
          title: loaded.title,
          author: loaded.author,
          subject: loaded.subject,
          keywords: loaded.keywords,
        });
      },
      (cause) => setError(errorText(cause)),
    );
  }, []);
  const changed =
    !!props &&
    (['title', 'author', 'subject', 'keywords'] as const).some(
      (key) => fields[key].trim() !== props[key],
    );
  const save = async () => {
    try {
      await ctx.engine.call('metadata.set', { docId, fields });
      ctx.ui.toast('Document properties updated. Save the document to keep them.');
      close();
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="p4b-form p4b-wide" data-testid="properties-dialog">
      <section className="p4b-section">
        <h3>Description</h3>
        {(['title', 'author', 'subject', 'keywords'] as const).map((key) => (
          <label key={key} className="p4b-field">
            <span>{key[0].toUpperCase() + key.slice(1)}</span>
            <input
              aria-label={key[0].toUpperCase() + key.slice(1)}
              dir="auto"
              value={fields[key]}
              disabled={!props}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          </label>
        ))}
      </section>
      {props && security && (
        <>
          <section className="p4b-section">
            <h3>Document</h3>
            <dl className="p4b-props">
              <dt>File</dt>
              <dd>{tab.file.name}</dd>
              <dt>File size</dt>
              <dd>
                {tab.file.handle
                  ? `${formatBytes(tab.file.size)}${tab.info.dirty ? ' (before unsaved changes)' : ''}`
                  : 'Not saved yet'}
              </dd>
              <dt>Pages</dt>
              <dd>{props.pageCount}</dd>
              <dt>Page size</dt>
              <dd>
                {pageSizeText(props.pageSize.width, props.pageSize.height)}
                {props.pageSize.mixed ? `, page ${tab.page + 1}. Page sizes vary.` : ''}
              </dd>
              <dt>PDF version</dt>
              <dd>{props.version}</dd>
              <dt>Created</dt>
              <dd>{when(props.created)}</dd>
              <dt>Modified</dt>
              <dd>{when(props.modified)}</dd>
              <dt>Application</dt>
              <dd>{props.creator || 'Not recorded'}</dd>
              <dt>PDF producer</dt>
              <dd>{props.producer || 'Not recorded'}</dd>
              <dt>Security</dt>
              <dd data-testid="properties-security">{securityText(security)}</dd>
            </dl>
          </section>
          <section className="p4b-section">
            <h3>
              Fonts{' '}
              <span className="muted">
                {plural(props.fonts.length, 'font')}
                {props.fontsTruncated ? ', first 500 shown' : ''}
              </span>
            </h3>
            {props.fonts.length ? (
              <div className="p4b-list" style={{ maxHeight: 180 }}>
                <table className="p4b-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Embedded</th>
                      <th>Subset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.fonts.map((font, i) => (
                      <tr key={i}>
                        <td>{font.name}</td>
                        <td>{font.type}</td>
                        <td>{font.embedded ? 'Yes' : 'No'}</td>
                        <td>{font.subset ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="p4b-hint">No fonts are used.</p>
            )}
          </section>
        </>
      )}
      {error && (
        <p className="p4b-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!changed} onClick={() => void save()}>
          Save changes
        </button>
      </footer>
    </div>
  );
}

export async function showProperties(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  await openDialog<void>('Document properties', (close) => (
    <PropertiesForm ctx={ctx} docId={doc.docId} close={close} />
  ));
}
