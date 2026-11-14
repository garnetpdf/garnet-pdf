import { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginContext } from '../../plugin-host/types';
import { redactionPending } from '../../actions';
import type { RedactHit, RedactMark } from '../../../engine/ops/redact';
import type { ApplyOptions } from '../../../engine/tools/redact/apply';
import { PRESETS, type FindSpec, type PresetId } from '../../../engine/tools/redact/patterns';
import { Check, errorText, Field, openDialog, plural, Progress } from './kit';

/** Documents whose recent-files thumbnail must be redrawn after the next save. */
export const thumbnailRefresh = new Set<string>();

type FindMode = 'literal' | 'regex' | 'presets';

function HitText({ hit }: { hit: RedactHit }) {
  return (
    <span className="p4b-grow p4b-hit" title={`${hit.before}${hit.text}${hit.after}`}>
      {hit.before && <>…{hit.before}</>}
      <mark>{hit.text}</mark>
      {hit.after && <>{hit.after}…</>}
    </span>
  );
}

function FindForm({
  ctx,
  docId,
  close,
}: {
  ctx: PluginContext;
  docId: string;
  close: (apply?: boolean) => void;
}) {
  const [mode, setMode] = useState<FindMode>('literal');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [presets, setPresets] = useState<PresetId[]>(['email']);
  const [hits, setHits] = useState<RedactHit[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const spec = (): FindSpec | null => {
    if (mode === 'presets') return presets.length ? { kind: 'presets', presets } : null;
    if (!query.trim()) return null;
    return mode === 'regex'
      ? { kind: 'regex', pattern: query, caseSensitive }
      : { kind: 'literal', query, caseSensitive, wholeWord };
  };
  const search = async () => {
    const value = spec();
    if (!value)
      return setError(mode === 'presets' ? 'Choose at least one pattern.' : 'Enter text to find.');
    setError('');
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ done: 0, total: 0 });
    try {
      const result = await ctx.engine.call(
        'redact.find',
        { docId, spec: value },
        {
          signal: controller.signal,
          onProgress: (data) => {
            const p = data as { page?: number; pages?: number };
            if (typeof p.page === 'number') setProgress({ done: p.page, total: p.pages ?? 0 });
          },
        },
      );
      setHits(result.hits);
      setTruncated(result.truncated);
      setExcluded(new Set());
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    } finally {
      if (abort.current === controller) setProgress(null);
    }
  };
  const chosen = useMemo(
    () => (hits || []).filter((hit) => !excluded.has(hit.id)),
    [hits, excluded],
  );
  const pages = new Set(chosen.map((hit) => hit.pageIndex)).size;
  const mark = async (apply: boolean) => {
    if (!chosen.length) return;
    try {
      await ctx.engine.call('redact.markHits', {
        docId,
        hits: chosen.map((hit) => ({ pageId: hit.pageId, quads: hit.quads })),
      });
      ctx.ui.toast(
        `Marked ${plural(chosen.length, 'result')} for redaction.${apply ? '' : ' Choose Apply redactions to remove them.'}`,
      );
      close(apply);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="p4b-form p4b-wide" data-testid="find-redact-dialog">
      <section className="p4b-section">
        <div className="segmented" role="group" aria-label="Find">
          {(
            [
              ['literal', 'Text'],
              ['regex', 'Pattern'],
              ['presets', 'Common information'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode !== 'presets' ? (
          <form
            className="p4b-row"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <input
              aria-label={mode === 'regex' ? 'Regular expression' : 'Text to find'}
              placeholder={
                mode === 'regex' ? 'Regular expression, for example \\d{6}' : 'Text to find'
              }
              value={query}
              autoFocus
              style={{ flex: 1 }}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Check checked={caseSensitive} onChange={setCaseSensitive} label="Match case" />
            {mode === 'literal' && (
              <Check checked={wholeWord} onChange={setWholeWord} label="Whole words" />
            )}
            <button type="submit" className="primary">
              Find
            </button>
          </form>
        ) : (
          <>
            <div className="p4b-grid-2">
              {(Object.keys(PRESETS) as PresetId[]).map((id) => (
                <Check
                  key={id}
                  checked={presets.includes(id)}
                  onChange={(on) =>
                    setPresets(on ? [...presets, id] : presets.filter((p) => p !== id))
                  }
                  label={PRESETS[id].label}
                  help={PRESETS[id].example}
                />
              ))}
            </div>
            <div className="p4b-row">
              <button type="button" className="primary" onClick={() => void search()}>
                Find
              </button>
            </div>
          </>
        )}
      </section>
      {progress && (
        <Progress
          label="Searching pages"
          done={progress.done}
          total={progress.total}
          onCancel={() => abort.current?.abort()}
        />
      )}
      {error && (
        <p className="p4b-error" role="alert">
          {error}
        </p>
      )}
      {hits && !progress && (
        <section className="p4b-section">
          <div className="p4b-row">
            <h3>
              {hits.length
                ? `${plural(hits.length, 'result')} on ${plural(new Set(hits.map((h) => h.pageIndex)).size, 'page')}`
                : 'No results'}
            </h3>
            {hits.length > 0 && (
              <span className="p4b-count">
                <button type="button" onClick={() => setExcluded(new Set())}>
                  Select all
                </button>
                <button type="button" onClick={() => setExcluded(new Set(hits.map((h) => h.id)))}>
                  Select none
                </button>
              </span>
            )}
          </div>
          {truncated && (
            <p className="p4b-notice">
              Only the first {hits.length} results are shown. Narrow the search to see the rest.
            </p>
          )}
          {hits.length > 0 && (
            <div className="p4b-list" role="list" aria-label="Results">
              {hits.map((hit) => (
                <label key={hit.id} className="p4b-list-item" role="listitem">
                  <input
                    type="checkbox"
                    checked={!excluded.has(hit.id)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.delete(hit.id);
                      else next.add(hit.id);
                      setExcluded(next);
                    }}
                  />
                  <span className="p4b-page-tag">Page {hit.pageIndex + 1}</span>
                  <HitText hit={hit} />
                  {mode === 'presets' && <span className="p4b-count">{hit.label}</span>}
                </label>
              ))}
            </div>
          )}
        </section>
      )}
      <footer>
        <button type="button" onClick={() => close()}>
          Cancel
        </button>
        <button type="button" disabled={!chosen.length} onClick={() => void mark(false)}>
          {chosen.length ? `Mark ${plural(chosen.length, 'result')}` : 'Mark results'}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!chosen.length}
          onClick={() => void mark(true)}
        >
          Mark and apply
        </button>
      </footer>
      {pages > 0 && (
        <p className="p4b-hint">
          Selected results are on {plural(pages, 'page')}. Marks can be reviewed before anything is
          removed.
        </p>
      )}
    </div>
  );
}

export async function findAndRedact(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  const apply = await openDialog<boolean>('Find and redact', (close) => (
    <FindForm ctx={ctx} docId={doc.docId} close={close} />
  ));
  if (apply) await applyRedactions(ctx);
}

function ApplyForm({
  ctx,
  docId,
  close,
}: {
  ctx: PluginContext;
  docId: string;
  close: (applied?: boolean) => void;
}) {
  const [marks, setMarks] = useState<RedactMark[] | null>(null);
  const [options, setOptions] = useState<ApplyOptions>({
    blackBoxes: true,
    overlayText: '',
    images: 'pixels',
    lineArt: 'covered',
    removeAnnotations: true,
  });
  const [overlay, setOverlay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () =>
    ctx.engine
      .call('redact.marks', { docId })
      .then(setMarks, (cause) => setError(errorText(cause)));
  useEffect(() => void load(), []);
  const remove = async (ids: string[] | 'all') => {
    await ctx.engine.call('redact.removeMarks', { docId, ids });
    await load();
  };
  const pages = new Set((marks || []).map((mark) => mark.pageIndex)).size;
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const report = await ctx.engine.call('redact.apply', {
        docId,
        options: {
          ...options,
          overlayText:
            options.blackBoxes && overlay ? options.overlayText?.trim() || 'Redacted' : undefined,
        },
      });
      if (!report.applied) {
        setError('There are no redaction marks to apply.');
        return;
      }
      redactionPending.add(docId);
      thumbnailRefresh.add(docId);
      const extras = report.removedAnnotations
        ? ` Removed ${plural(report.removedAnnotations, 'comment or field', 'comments or fields')}.`
        : '';
      if (report.residuals.length)
        ctx.ui.toast(
          `Redacted ${plural(report.marks, 'area')}, but some text under the marks could not be confirmed removed on page ${report.residuals[0].pageIndex + 1}. Check before sharing.`,
        );
      else
        ctx.ui.toast(
          `Redacted ${plural(report.marks, 'area')} on ${plural(report.redactedPages, 'page')}.${extras} Save to make it permanent.`,
        );
      close(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="p4b-form" data-testid="apply-redactions-dialog">
      <section className="p4b-section">
        <div className="p4b-row">
          <h3>
            {marks === null
              ? 'Loading marks'
              : marks.length
                ? `${plural(marks.length, 'mark')} on ${plural(pages, 'page')}`
                : 'No redaction marks yet'}
          </h3>
          {!!marks?.length && (
            <span className="p4b-count">
              <button type="button" onClick={() => void remove('all')}>
                Remove all marks
              </button>
            </span>
          )}
        </div>
        {marks && !marks.length && (
          <p className="p4b-hint">
            Mark text with Find and redact, Mark selected text, or Mark area first.
          </p>
        )}
        {!!marks?.length && (
          <div className="p4b-list" role="list" aria-label="Redaction marks">
            {marks.map((mark) => (
              <div key={mark.id} className="p4b-list-item" role="listitem">
                <span className="p4b-page-tag">Page {mark.pageIndex + 1}</span>
                <span className="p4b-grow">{mark.text || 'Area without text'}</span>
                <button
                  type="button"
                  aria-label={`Remove mark on page ${mark.pageIndex + 1}`}
                  onClick={() => void remove([mark.id])}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="p4b-section">
        <h3>Options</h3>
        <Check
          checked={options.blackBoxes}
          onChange={(blackBoxes) => setOptions({ ...options, blackBoxes })}
          label="Fill redacted areas with black boxes"
          help="When off, the areas are left blank."
        />
        <div className="p4b-row">
          <Check
            checked={overlay && options.blackBoxes}
            disabled={!options.blackBoxes}
            onChange={setOverlay}
            label="Show text on the boxes"
          />
          <input
            aria-label="Overlay text"
            placeholder="Redacted"
            value={options.overlayText}
            disabled={!overlay || !options.blackBoxes}
            maxLength={40}
            onChange={(e) => setOptions({ ...options, overlayText: e.target.value })}
          />
        </div>
        <Field label="Images under marks">
          <select
            aria-label="Images under marks"
            value={options.images}
            onChange={(e) =>
              setOptions({ ...options, images: e.target.value as ApplyOptions['images'] })
            }
          >
            <option value="pixels">Blank the covered pixels</option>
            <option value="remove">Remove the whole image</option>
            <option value="none">Leave images unchanged</option>
          </select>
        </Field>
        <Check
          checked={options.lineArt !== 'none'}
          onChange={(on) => setOptions({ ...options, lineArt: on ? 'covered' : 'none' })}
          label="Remove lines and shapes under marks"
        />
        <Check
          checked={options.removeAnnotations}
          onChange={(removeAnnotations) => setOptions({ ...options, removeAnnotations })}
          label="Remove comments and form fields under marks"
        />
      </section>
      <p className="p4b-notice">
        Applying removes the marked content from this document. After you save, undo history and
        recovery copies are cleared so it cannot be brought back.
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
          disabled={busy || !marks?.length}
          onClick={() => void apply()}
        >
          {marks?.length ? `Apply ${plural(marks.length, 'redaction')}` : 'Apply redactions'}
        </button>
      </footer>
    </div>
  );
}

export async function applyRedactions(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  await openDialog<boolean>('Apply redactions', (close) => (
    <ApplyForm ctx={ctx} docId={doc.docId} close={close} />
  ));
}
