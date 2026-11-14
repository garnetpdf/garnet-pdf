/** Page labels (the numbers shown for pages, like i, ii, iii then 1, 2, 3). */
import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { labelStrings, type LabelRange, type LabelStyle } from '../../../../engine/pages/labels';
import { Button, Dialog, IconButton } from '../../../ui';
import { notify, pageContext, pageOp } from '../../organize/pageActions';
import { ErrorText, Footer } from '../fields';
import type { DialogProps } from './structure';

const STYLES: [LabelStyle, string][] = [
  ['D', '1, 2, 3'],
  ['r', 'i, ii, iii'],
  ['R', 'I, II, III'],
  ['a', 'a, b, c'],
  ['A', 'A, B, C'],
  ['', 'No number (prefix only)'],
];

interface Draft {
  key: number;
  start: string;
  style: LabelStyle;
  prefix: string;
  first: string;
}

let keys = 0;
function draftOf(range: LabelRange): Draft {
  return { key: ++keys, start: String(range.start + 1), style: range.style, prefix: range.prefix, first: String(range.first) };
}

export function LabelsDialog({ tab, close }: DialogProps) {
  const count = tab.info.pageCount;
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void pageContext()
      .engine.call('pages.getLabels', { docId: tab.info.docId }, { priority: 160 })
      .then((r) => live && setDrafts((r.ranges ?? [{ start: 0, style: 'D', prefix: '', first: 1 }]).map(draftOf)))
      .catch(() => live && setDrafts([draftOf({ start: 0, style: 'D', prefix: '', first: 1 })]));
    return () => {
      live = false;
    };
  }, [tab.info.docId]);
  let error: string | null = null;
  let ranges: LabelRange[] = [];
  if (drafts) {
    ranges = drafts.map((d) => ({ start: Number(d.start) - 1, style: d.style, prefix: d.prefix, first: Number(d.first) })).sort((a, b) => a.start - b.start);
    const starts = new Set<number>();
    for (const r of ranges) {
      if (!Number.isInteger(r.start) || r.start < 0 || r.start >= count) error = `Start pages must be between 1 and ${count}.`;
      else if (starts.has(r.start)) error = 'Two ranges start on the same page.';
      else if (!Number.isInteger(r.first) || r.first < 1) error = 'Numbers must start at 1 or more.';
      starts.add(r.start);
    }
    if (!error && ranges[0]?.start !== 0) error = 'The first range must start at page 1.';
  }
  const preview = !error && drafts ? labelStrings(ranges, count) : [];
  const update = (key: number, patch: Partial<Draft>) => setDrafts((list) => list && list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const save = async (value: LabelRange[] | null) => {
    setBusy(true);
    try {
      const result = await pageOp('pages.setLabels', { docId: tab.info.docId, ranges: value });
      if (!result) return;
      notify(value ? 'Page labels updated.' : 'Page labels removed; pages are numbered 1, 2, 3.');
      close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Page labels" onClose={close}>
      <div className="pt-body pt-wide">
        <p className="pt-note">Labels are the page numbers shown in the page box and thumbnails, for example i–iv for a preface, then 1, 2, 3.</p>
        <table className="pt-table">
          <thead>
            <tr>
              <th>From page</th>
              <th>Style</th>
              <th>Prefix</th>
              <th>Start at</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {(drafts ?? []).map((d, i) => (
              <tr key={d.key}>
                <td>
                  <input aria-label={`Range ${i + 1} first page`} type="number" min={1} max={count} className="pt-number" value={d.start} onChange={(e) => update(d.key, { start: e.target.value })} />
                </td>
                <td>
                  <select aria-label={`Range ${i + 1} style`} value={d.style} onChange={(e) => update(d.key, { style: e.target.value as LabelStyle })}>
                    {STYLES.map(([value, label]) => (
                      <option key={value || 'none'} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input aria-label={`Range ${i + 1} prefix`} value={d.prefix} placeholder="None" onChange={(e) => update(d.key, { prefix: e.target.value })} />
                </td>
                <td>
                  <input aria-label={`Range ${i + 1} start number`} type="number" min={1} className="pt-number" value={d.first} onChange={(e) => update(d.key, { first: e.target.value })} />
                </td>
                <td>
                  <IconButton label={`Remove range ${i + 1}`} disabled={(drafts?.length ?? 0) <= 1} onClick={() => setDrafts((list) => list && list.filter((x) => x.key !== d.key))}>
                    <X size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button
          type="button"
          onClick={() =>
            setDrafts((list) => [
              ...(list ?? []),
              draftOf({ start: Math.min(count - 1, Math.max(tab.page, (list?.length ?? 0) ? Math.max(...(list ?? []).map((d) => Number(d.start))) : 0)), style: 'D', prefix: '', first: 1 }),
            ])
          }
        >
          <Plus size={15} />
          Add range
        </Button>
        <div className="pt-label-preview" aria-label="Label preview">
          {preview.slice(0, 16).map((label, i) => (
            <span key={i}>
              <small>{i + 1}</small>
              {label || '·'}
            </span>
          ))}
          {preview.length > 16 && <span className="muted">… {preview[preview.length - 1]}</span>}
        </div>
      </div>
      <Footer
        busy={busy}
        disabled={Boolean(error) || !drafts}
        action="Apply"
        onAction={() => void save(ranges)}
        onCancel={close}
        extra={
          <>
            <Button type="button" disabled={busy} onClick={() => void save(null)}>
              Use 1, 2, 3
            </Button>
            <ErrorText>{error}</ErrorText>
          </>
        }
      />
    </Dialog>
  );
}
