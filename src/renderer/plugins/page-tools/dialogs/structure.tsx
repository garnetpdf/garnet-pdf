/** Dialogs that change which pages a document has: insert, extract, split, delete, replace, combine, blank pages. */
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FilePlus2, X } from 'lucide-react';
import type { PageId } from '../../../../shared/engine-api';
import type { SplitMode } from '../../../../engine/pages/split';
import { rangeError } from '../../../../engine/pages/range';
import { useApp, type Tab } from '../../../store';
import { Button, Dialog, IconButton } from '../../../ui';
import {
  baseName,
  friendlyError,
  insertFiles,
  notify,
  openAsNewTab,
  pageContext,
  pageOp,
  pickFiles,
  plural,
  refreshOutline,
  selectPages,
  type PickedFile,
} from '../../organize/pageActions';
import { selectedInOrder } from '../../organize/state';
import { ErrorText, Footer, PAPER, Row, Section, formatBytes, usePageScope } from '../fields';

export interface DialogProps {
  tab: Tab;
  close: () => void;
  at?: number;
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setProgress('');
    }
  };
  return { busy, progress, setProgress, run };
}

/** Where new pages go: before or after a page, or at the start or end. */
function usePosition(tab: Tab, initialGap?: number) {
  const count = tab.info.pageCount;
  const selected = selectedInOrder(tab.info.docId, tab.info.pages);
  const lastSelected = selected.length ? tab.info.pages.findIndex((p) => p.id === selected[selected.length - 1]) : tab.page;
  const [where, setWhere] = useState<'after' | 'before' | 'start' | 'end'>(initialGap === undefined ? 'after' : initialGap >= count ? 'end' : 'after');
  const [page, setPage] = useState(String(initialGap === undefined ? lastSelected + 1 : Math.max(1, initialGap)));
  const number = Number(page);
  const valid = where === 'start' || where === 'end' || (Number.isInteger(number) && number >= 1 && number <= count);
  const gap = where === 'start' ? 0 : where === 'end' ? count : where === 'before' ? number - 1 : number;
  const element = (
    <Row label="Position" htmlFor="pt-position">
      <div className="pt-inline">
        <select id="pt-position" aria-label="Position" value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
          <option value="after">After page</option>
          <option value="before">Before page</option>
          <option value="start">At the start</option>
          <option value="end">At the end</option>
        </select>
        {(where === 'after' || where === 'before') && (
          <input
            aria-label="Page number"
            type="number"
            min={1}
            max={count}
            value={page}
            onChange={(e) => setPage(e.target.value)}
            className="pt-number"
            aria-invalid={!valid}
          />
        )}
        <span className="muted">of {count.toLocaleString()}</span>
      </div>
    </Row>
  );
  return { gap: valid ? gap : null, element };
}

export function InsertDialog({ tab, close, at, blank: startBlank }: DialogProps & { blank?: boolean }) {
  const [source, setSource] = useState<'file' | 'blank'>(startBlank ? 'blank' : 'file');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [range, setRange] = useState('');
  const [fit, setFit] = useState(false);
  const [count, setCount] = useState('1');
  const [size, setSize] = useState('same');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const position = usePosition(tab, at);
  const { busy, run } = useBusy();
  const reference = tab.info.pages[Math.max(0, Math.min(tab.info.pageCount - 1, (position.gap ?? 1) - 1))];
  const blankSize = (): [number, number] => {
    if (size === 'same') return [Math.round(reference.width), Math.round(reference.height)];
    const [w, h] = PAPER[size];
    return orientation === 'portrait' ? [w, h] : [h, w];
  };
  const n = Number(count);
  const error =
    position.gap === null
      ? 'Enter a page number in this document.'
      : source === 'file'
        ? !files.length
          ? 'Choose a file to insert.'
          : range.trim() && !/^[\d\s,-]+$/.test(range)
            ? 'Use page numbers like 1-3, 7.'
            : null
        : !(Number.isInteger(n) && n >= 1 && n <= 500)
          ? 'Insert between 1 and 500 blank pages.'
          : null;
  const submit = () =>
    run(async () => {
      if (error || position.gap === null) return;
      if (source === 'blank') {
        const result = await pageOp('pages.insertBlank', { docId: tab.info.docId, at: position.gap, count: n, size: blankSize() });
        if (!result) return;
        if (result.inserted?.length) selectPages(tab.info.docId, result.inserted);
      } else {
        const inserted = await insertFiles(tab.info.docId, position.gap, files, { pages: range.trim() || undefined, fitTo: fit ? blankSize() : undefined });
        if (!inserted) return;
        notify(`Inserted ${plural(inserted.length, 'page')}.`);
      }
      close();
    });
  return (
    <Dialog title="Insert pages" onClose={close}>
      <div className="pt-body">
        <div className="pt-choice" role="radiogroup" aria-label="Insert">
          <label>
            <input type="radio" name="pt-insert-source" checked={source === 'file'} onChange={() => setSource('file')} />
            From a file (PDF or image)
          </label>
          <label>
            <input type="radio" name="pt-insert-source" checked={source === 'blank'} onChange={() => setSource('blank')} />
            Blank pages
          </label>
        </div>
        {source === 'file' ? (
          <>
            <Row label="File">
              <div className="pt-inline">
                <Button type="button" onClick={() => void pickFiles().then((f) => f.length && setFiles(f))}>
                  <FilePlus2 size={15} />
                  Choose…
                </Button>
                <span className="pt-file-name">{files.length ? files.map((f) => f.name).join(', ') : 'No file chosen'}</span>
              </div>
            </Row>
            <Row label="Pages of the file" hint="Leave empty for all pages.">
              <input aria-label="Pages of the file" value={range} placeholder="All" onChange={(e) => setRange(e.target.value)} />
            </Row>
            <Row label="Images">
              <label className="pt-check">
                <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
                Fit images to the page size below
              </label>
            </Row>
          </>
        ) : (
          <Row label="Number of pages">
            <input aria-label="Number of pages" type="number" min={1} max={500} className="pt-number" value={count} onChange={(e) => setCount(e.target.value)} />
          </Row>
        )}
        {(source === 'blank' || fit) && (
          <Row label="Page size">
            <div className="pt-inline">
              <select aria-label="Page size" value={size} onChange={(e) => setSize(e.target.value)}>
                <option value="same">Same as page {Math.max(1, position.gap ?? 1)}</option>
                {Object.keys(PAPER).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              {size !== 'same' && (
                <select aria-label="Orientation" value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              )}
            </div>
          </Row>
        )}
        {position.element}
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action="Insert" onAction={() => void submit()} onCancel={close} extra={<ErrorText>{error && (files.length || source === 'blank') ? error : null}</ErrorText>} />
    </Dialog>
  );
}

export function ExtractDialog({ tab, close }: DialogProps) {
  const scope = usePageScope(tab);
  const [each, setEach] = useState(false);
  const [remove, setRemove] = useState(false);
  const { busy, run } = useBusy();
  const all = scope.ids.length >= tab.info.pageCount;
  const error = scope.error ?? (remove && all ? 'Keep at least one page in the document, or extract without deleting.' : null);
  const submit = () =>
    run(async () => {
      if (error) return;
      const result = await pageOp('pages.extract', { docId: tab.info.docId, pageIds: scope.ids, each, deleteAfter: remove, baseName: tab.file.name });
      if (!result) return;
      if (each) {
        const saved = await window.garnet.saveFiles({
          files: result.files.map((f) => ({ name: f.name, bytes: f.bytes, expectedPageCount: f.pageCount })),
          title: 'Choose a folder for the extracted pages',
          nearHandle: tab.file.handle || undefined,
        });
        if (saved) notify(`Saved ${plural(saved.files.length, 'file')} in ${saved.folderName}.`);
        else if (remove) notify('The pages were removed. Undo to bring them back, then extract again.');
      } else {
        const file = result.files[0];
        await openAsNewTab(file.bytes, file.name);
      }
      if (remove) void refreshOutline(tab.info.docId);
      close();
    });
  return (
    <Dialog title="Extract pages" onClose={close}>
      <div className="pt-body">
        {scope.element}
        <Section title="Options">
          <label className="pt-check">
            <input type="checkbox" checked={each} onChange={(e) => setEach(e.target.checked)} />
            Save each page as a separate file
          </label>
          <label className="pt-check">
            <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
            Delete the pages from this document after extracting
          </label>
        </Section>
        <p className="pt-note">
          {each
            ? `You will choose a folder for ${plural(scope.ids.length, 'file')}.`
            : `The ${plural(scope.ids.length, 'page')} open in a new tab; bookmarks, links and form fields on them are kept.`}
        </p>
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action={each ? 'Extract and save…' : 'Extract'} onAction={() => void submit()} onCancel={close} extra={<ErrorText>{remove && all ? error : null}</ErrorText>} />
    </Dialog>
  );
}

interface PlanItem {
  name: string;
  first: number;
  last: number;
  pageCount: number;
  estimatedBytes?: number;
  oversize?: boolean;
}

export function SplitDialog({ tab, close }: DialogProps) {
  const [mode, setMode] = useState<SplitMode>('every');
  const [every, setEvery] = useState('10');
  const [megabytes, setMegabytes] = useState('5');
  const [before, setBefore] = useState('');
  const [pattern, setPattern] = useState('');
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const { busy, progress, setProgress, run } = useBusy();
  const options = useMemo(() => {
    const base = { mode, baseName: tab.file.name, pattern: pattern.trim() || undefined };
    if (mode === 'every') return { ...base, every: Number(every) };
    if (mode === 'size') return { ...base, maxBytes: Math.round(Number(megabytes) * 1024 * 1024) };
    if (mode === 'before') return { ...base, before: before.split(/[\s,]+/).filter(Boolean).map(Number) };
    return base;
  }, [mode, every, megabytes, before, pattern, tab.file.name]);
  const inputError =
    mode === 'every' && !(Number.isInteger(Number(every)) && Number(every) >= 1)
      ? 'Enter a whole number of pages.'
      : mode === 'size' && !(Number(megabytes) >= 0.01)
        ? 'Enter a size in MB.'
        : mode === 'before' && (!before.trim() || rangeError(before.replace(/[\s,]+/g, ','), tab.info.pageCount))
          ? 'Enter page numbers like 5, 12, 30.'
          : null;
  useEffect(() => {
    if (inputError) {
      setPlan(null);
      setPlanError(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      pageContext()
        .engine.call('pages.splitPlan', { docId: tab.info.docId, ...options }, { priority: 160 })
        .then((items) => {
          if (!live) return;
          setPlan(items);
          setPlanError(null);
        })
        .catch((e) => {
          if (!live) return;
          setPlan(null);
          setPlanError(friendlyError(e));
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [options, inputError, tab.info.docId, tab.info.revision]);
  const error = inputError ?? planError ?? (plan && plan.length < 2 ? 'This would make only one file. Choose smaller parts.' : null);
  const submit = () =>
    run(async () => {
      if (error || !plan) return;
      setProgress(`Preparing 0 of ${plan.length} files…`);
      const result = await pageOp('pages.split', { docId: tab.info.docId, ...options }, {
        onProgress: (data) => {
          const p = data as { done?: number; total?: number };
          if (p && p.total) setProgress(`Preparing ${p.done} of ${p.total} files…`);
        },
      });
      if (!result) return;
      setProgress('Saving…');
      const saved = await window.garnet.saveFiles({
        files: result.files.map((f) => ({ name: f.name, bytes: f.bytes, expectedPageCount: f.pageCount })),
        title: 'Choose a folder for the split files',
        nearHandle: tab.file.handle || undefined,
      });
      if (!saved) return;
      notify(`Saved ${plural(saved.files.length, 'file')} in ${saved.folderName}.`);
      close();
    });
  const oversize = plan?.filter((p) => p.oversize).length ?? 0;
  return (
    <Dialog title="Split document" onClose={close}>
      <div className="pt-body pt-wide">
        <div className="pt-columns">
          <div>
            <Section title="Split by">
              <label className="pt-check">
                <input type="radio" name="pt-split" checked={mode === 'every'} onChange={() => setMode('every')} />
                Number of pages
                <input aria-label="Pages per file" type="number" min={1} className="pt-number" value={every} onFocus={() => setMode('every')} onChange={(e) => setEvery(e.target.value)} />
                <span className="muted">per file</span>
              </label>
              <label className="pt-check">
                <input type="radio" name="pt-split" checked={mode === 'size'} onChange={() => setMode('size')} />
                File size up to
                <input aria-label="Largest file size in MB" type="number" min={0.01} step={0.5} className="pt-number" value={megabytes} onFocus={() => setMode('size')} onChange={(e) => setMegabytes(e.target.value)} />
                <span className="muted">MB (estimated)</span>
              </label>
              <label className="pt-check">
                <input type="radio" name="pt-split" checked={mode === 'bookmarks'} onChange={() => setMode('bookmarks')} />
                Top-level bookmarks (one file per bookmark)
              </label>
              <label className="pt-check">
                <input type="radio" name="pt-split" checked={mode === 'before'} onChange={() => setMode('before')} />
                Before pages
                <input aria-label="Split before pages" value={before} placeholder="5, 12" onFocus={() => setMode('before')} onChange={(e) => setBefore(e.target.value)} />
              </label>
            </Section>
            <Row label="File names" hint="{name} file name, {n} part number, {bookmark}, {first} and {last} page.">
              <input aria-label="File name pattern" value={pattern} placeholder={mode === 'bookmarks' ? '{bookmark}' : '{name} - part {n}'} onChange={(e) => setPattern(e.target.value)} />
            </Row>
          </div>
          <div className="pt-plan" aria-label="Files to create">
            <div className="pt-plan-head">{plan ? `${plural(plan.length, 'file')}` : 'Files'}</div>
            {plan ? (
              <ol>
                {plan.slice(0, 200).map((item, i) => (
                  <li key={i} className={item.oversize ? 'pt-warn' : ''}>
                    <span className="pt-plan-name" title={item.name}>
                      {item.name}
                    </span>
                    <span className="muted">
                      {item.first === item.last ? `p. ${item.first}` : `pp. ${item.first}-${item.last}`}
                      {item.estimatedBytes ? ` · ~${formatBytes(item.estimatedBytes)}` : ''}
                    </span>
                  </li>
                ))}
                {plan.length > 200 && <li className="muted">and {(plan.length - 200).toLocaleString()} more</li>}
              </ol>
            ) : (
              <p className="muted pt-plan-empty">{error ?? 'Working out the files…'}</p>
            )}
          </div>
        </div>
        {oversize > 0 && <p className="pt-note pt-warn">{plural(oversize, 'page')} alone {oversize === 1 ? 'is' : 'are'} larger than the limit and will be saved on {oversize === 1 ? 'its' : 'their'} own.</p>}
        <p className="pt-note">The original document is not changed. Bookmarks, links and labels are kept in each file.</p>
      </div>
      <Footer busy={busy} progress={progress} disabled={Boolean(error) || !plan} action="Split and save…" onAction={() => void submit()} onCancel={close} extra={<ErrorText>{plan ? null : inputError}</ErrorText>} />
    </Dialog>
  );
}

export function DeletePagesDialog({ tab, close }: DialogProps) {
  const scope = usePageScope(tab, { allowAll: false });
  const { busy, run } = useBusy();
  const error = scope.error ?? (scope.ids.length >= tab.info.pageCount ? 'A document needs at least one page.' : null);
  const submit = () =>
    run(async () => {
      if (error) return;
      const result = await pageOp('pages.delete', { docId: tab.info.docId, pageIds: scope.ids });
      if (!result) return;
      void refreshOutline(tab.info.docId);
      notify(`Deleted ${plural(scope.ids.length, 'page')}. Undo with Ctrl+Z.`);
      close();
    });
  return (
    <Dialog title="Delete pages" onClose={close}>
      <div className="pt-body">
        {scope.element}
        <p className="pt-note">Bookmarks, links and form fields that only point to these pages are removed with them.</p>
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action={scope.ids.length ? `Delete ${plural(scope.ids.length, 'page')}` : 'Delete'} onAction={() => void submit()} onCancel={close} extra={<ErrorText>{error && scope.ids.length >= tab.info.pageCount ? error : null}</ErrorText>} />
    </Dialog>
  );
}

export function ReplaceDialog({ tab, close }: DialogProps) {
  const scope = usePageScope(tab, { allowAll: true, label: 'Pages to replace' });
  const [file, setFile] = useState<PickedFile | null>(null);
  const [from, setFrom] = useState('1');
  const { busy, run } = useBusy();
  const error = scope.error ?? (!file ? 'Choose the file with the new pages.' : !/^\s*\d+\s*$/.test(from) ? 'Enter the first page of the new file to use.' : null);
  const submit = () =>
    run(async () => {
      if (error || !file) return;
      const start = Number(from);
      const pages = `${start}-${start + scope.ids.length - 1}`;
      const result = await pageOp('pages.replace', { docId: tab.info.docId, pageIds: scope.ids, source: { bytes: file.bytes.slice(0), name: file.name, pages } });
      if (!result) return;
      void refreshOutline(tab.info.docId);
      notify(`Replaced ${plural(scope.ids.length, 'page')}.`);
      close();
    });
  return (
    <Dialog title="Replace pages" onClose={close}>
      <div className="pt-body">
        {scope.element}
        <Row label="New pages from">
          <div className="pt-inline">
            <Button type="button" onClick={() => void pickFiles().then((f) => f[0] && setFile(f[0]))}>
              <FilePlus2 size={15} />
              Choose…
            </Button>
            <span className="pt-file-name">{file?.name ?? 'No file chosen'}</span>
          </div>
        </Row>
        <Row label="Starting at page" hint={`Uses ${plural(scope.ids.length, 'page')} of the new file from this page on.`}>
          <input aria-label="Starting at page" type="number" min={1} className="pt-number" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Row>
        <p className="pt-note">Bookmarks and links to the replaced pages are kept and point to the new pages.</p>
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action="Replace" onAction={() => void submit()} onCancel={close} />
    </Dialog>
  );
}

interface CombineItem extends PickedFile {
  key: string;
  range: string;
  current?: boolean;
}

export function CombineDialog({ tab, close }: { tab?: Tab; close: () => void }) {
  const [items, setItems] = useState<CombineItem[]>(() =>
    tab ? [{ key: 'current', name: tab.file.name, bytes: new ArrayBuffer(0), range: '', current: true }] : [],
  );
  const [bookmarks, setBookmarks] = useState(true);
  const { busy, run } = useBusy();
  const add = async () => {
    const files = await pickFiles();
    setItems((list) => [...list, ...files.map((f, i) => ({ ...f, key: `${Date.now()}-${i}-${f.name}`, range: '' }))]);
  };
  const move = (index: number, delta: number) =>
    setItems((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, item);
      return next;
    });
  const rangeProblem = items.find((item) => item.range.trim() && !/^[\d\s,-]+$/.test(item.range));
  const error = items.length < 2 ? 'Add at least two files.' : rangeProblem ? `Check the pages for ${rangeProblem.name}.` : null;
  const submit = () =>
    run(async () => {
      if (error) return;
      const ctx = pageContext();
      let docId = tab?.info.docId;
      let temporary: string | null = null;
      const sources = items.map((item) => (item.current ? { bytes: new ArrayBuffer(0), useOpenDocument: true, name: item.name, pages: item.range.trim() || undefined } : { bytes: item.bytes.slice(0), name: item.name, pages: item.range.trim() || undefined }));
      try {
        if (!docId || !items.some((i) => i.current)) {
          // Each document has its own engine; combine runs in the engine of the first file.
          const first = items[0];
          const info = await ctx.engine.call('core.open', { bytes: first.bytes.slice(0), unsaved: true });
          temporary = docId = info.docId;
          sources[0] = { bytes: new ArrayBuffer(0), useOpenDocument: true, name: first.name, pages: first.range.trim() || undefined };
        }
        const result = await pageOp('pages.combine', { docId, sources, bookmarks, labels: true });
        if (!result) return;
        await openAsNewTab(result.bytes, 'Combined.pdf');
        notify(`Combined ${plural(items.length, 'file')} into ${plural(result.pageCount, 'page')}.`);
        close();
      } finally {
        if (temporary) await ctx.engine.call('core.close', { docId: temporary }).catch(() => {});
      }
    });
  return (
    <Dialog title="Combine files" onClose={close}>
      <div className="pt-body pt-wide">
        <div className="pt-combine-head">
          <span className="muted">Files are combined in this order into a new document. Your files are not changed.</span>
          <Button type="button" onClick={() => void add()}>
            <FilePlus2 size={15} />
            Add files…
          </Button>
        </div>
        <ol className="pt-combine-list" aria-label="Files to combine">
          {items.map((item, i) => (
            <li key={item.key}>
              <span className="pt-combine-index">{i + 1}</span>
              <span className="pt-combine-name" title={item.name}>
                {item.name}
                {item.current && <span className="pt-tag">Open document</span>}
                {!item.current && <span className="muted"> · {formatBytes(item.bytes.byteLength)}</span>}
              </span>
              <input
                aria-label={`Pages of ${item.name}`}
                placeholder="All pages"
                value={item.range}
                onChange={(e) => setItems((list) => list.map((x) => (x.key === item.key ? { ...x, range: e.target.value } : x)))}
              />
              <IconButton label={`Move ${item.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label={`Move ${item.name} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label={`Remove ${item.name}`} onClick={() => setItems((list) => list.filter((x) => x.key !== item.key))}>
                <X size={14} />
              </IconButton>
            </li>
          ))}
          {!items.length && <li className="pt-combine-empty muted">Add PDFs or images to combine.</li>}
        </ol>
        <label className="pt-check">
          <input type="checkbox" checked={bookmarks} onChange={(e) => setBookmarks(e.target.checked)} />
          Add a bookmark for each file (keeps the files' own bookmarks under it)
        </label>
      </div>
      <Footer busy={busy} disabled={Boolean(error)} action="Combine" onAction={() => void submit()} onCancel={close} extra={<ErrorText>{items.length >= 2 ? error : null}</ErrorText>} />
    </Dialog>
  );
}

interface Candidate {
  index: number;
  ink: number;
  hasText: boolean;
  annotations: number;
  pageId: PageId;
}

export function BlankPagesDialog({ tab, close }: DialogProps) {
  const [sensitivity, setSensitivity] = useState(4);
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<PageId>>(new Set());
  const { busy, progress, setProgress, run } = useBusy();
  const search = () =>
    run(async () => {
      setProgress('Checking pages…');
      const result = await pageOp(
        'pages.findBlank',
        { docId: tab.info.docId, maxInk: sensitivity / 1000 },
        {
          onProgress: (data) => {
            const p = data as { done?: number; total?: number };
            if (p?.total) setProgress(`Checked ${p.done} of ${p.total} pages…`);
          },
        },
      );
      if (!result) return;
      setFound(result);
      setChosen(new Set(result.filter((c) => !c.hasText && !c.annotations).map((c) => c.pageId)));
    });
  useEffect(() => {
    void search();
    // Searches once when the dialog opens; the button searches again.
  }, []);
  const remove = () =>
    run(async () => {
      const ids = [...chosen];
      if (!ids.length) return;
      if (ids.length >= tab.info.pageCount) {
        notify('A document needs at least one page.');
        return;
      }
      const result = await pageOp('pages.delete', { docId: tab.info.docId, pageIds: ids });
      if (!result) return;
      void refreshOutline(tab.info.docId);
      notify(`Deleted ${plural(ids.length, 'blank page')}. Undo with Ctrl+Z.`);
      close();
    });
  return (
    <Dialog title="Find blank pages" onClose={close}>
      <div className="pt-body">
        <Row label="Sensitivity" hint="Higher finds pages with a little more marking (scanner noise, page numbers).">
          <div className="pt-inline">
            <input type="range" aria-label="Sensitivity" min={1} max={20} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
            <Button type="button" disabled={busy} onClick={() => void search()}>
              Search again
            </Button>
          </div>
        </Row>
        <div className="pt-plan" aria-label="Blank page candidates">
          <div className="pt-plan-head">{found ? (found.length ? `${plural(found.length, 'candidate')}` : 'No blank pages found') : 'Searching…'}</div>
          {found && found.length > 0 && (
            <ol>
              {found.map((c) => (
                <li key={c.pageId}>
                  <label className="pt-check">
                    <input
                      type="checkbox"
                      checked={chosen.has(c.pageId)}
                      onChange={(e) =>
                        setChosen((set) => {
                          const next = new Set(set);
                          if (e.target.checked) next.add(c.pageId);
                          else next.delete(c.pageId);
                          return next;
                        })
                      }
                    />
                    Page {c.index + 1}
                  </label>
                  <span className="muted">
                    {(c.ink * 100).toFixed(2)}% marked{c.hasText ? ' · has text' : ''}
                    {c.annotations ? ` · ${plural(c.annotations, 'comment')}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <p className="pt-note">Nothing is deleted until you choose. Pages with text or comments are not ticked.</p>
      </div>
      <Footer busy={busy} progress={progress} disabled={!chosen.size} action={chosen.size ? `Delete ${plural(chosen.size, 'page')}` : 'Delete'} onAction={() => void remove()} onCancel={close} />
    </Dialog>
  );
}

export function useActiveTab(): Tab | undefined {
  return useApp((s) => s.tabs.find((t) => t.info.docId === s.activeId));
}

export { baseName };
