import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileImage, FileOutput, Images, Trash2 } from 'lucide-react';
import { definePlugin, type PluginContext } from '../../plugin-host/types';
import { shell } from '../../actions';
import { createEngineClient } from '../../../engine/client';
import {
  exportFileName,
  parsePageRange,
  safeBaseName,
  type PageSizeId,
} from '../../../engine/tools/export/pages';
import { formatBytes } from '../../../engine/tools/optimize/presets';
import {
  errorText,
  Field,
  openDialog,
  plural,
  Progress,
  tabFor,
  useObjectUrl,
  withIsolatedCopy,
} from '../protect/kit';

type Scope = 'all' | 'current' | 'range';

function usePages(
  docId: string,
  scope: Scope,
  range: string,
): { indices: number[]; error: string } {
  const tab = tabFor(docId);
  const count = tab?.info.pageCount ?? 0;
  try {
    if (scope === 'all') return { indices: Array.from({ length: count }, (_, i) => i), error: '' };
    if (scope === 'current') return { indices: [tab?.page ?? 0], error: '' };
    return { indices: parsePageRange(range, count), error: '' };
  } catch (cause) {
    return { indices: [], error: errorText(cause) };
  }
}

function PagePicker({
  scope,
  setScope,
  range,
  setRange,
  count,
}: {
  scope: Scope;
  setScope: (s: Scope) => void;
  range: string;
  setRange: (r: string) => void;
  count: number;
}) {
  return (
    <Field label="Pages">
      <span className="p4b-row">
        <select
          aria-label="Pages to export"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          <option value="all">All pages ({count})</option>
          <option value="current">Current page</option>
          <option value="range">Page range</option>
        </select>
        {scope === 'range' && (
          <input
            aria-label="Page range"
            placeholder="For example 1-3, 5"
            value={range}
            style={{ flex: 1 }}
            onChange={(e) => setRange(e.target.value)}
          />
        )}
      </span>
    </Field>
  );
}

function ImagesForm({
  ctx,
  docId,
  close,
}: {
  ctx: PluginContext;
  docId: string;
  close: () => void;
}) {
  const tab = tabFor(docId)!;
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(90);
  const [scope, setScope] = useState<Scope>('current');
  const [range, setRange] = useState('');
  const [pattern, setPattern] = useState('{name}-{page}');
  const [folder, setFolder] = useState<{ token: string; name: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const { indices, error: rangeError } = usePages(docId, scope, range);
  const extension = format === 'png' ? 'png' : 'jpg';
  const name = (index: number) =>
    exportFileName(
      pattern,
      tab.file.name,
      index,
      tab.info.pageCount,
      tab.info.pages[index]?.label || '',
      extension,
    );
  const run = async () => {
    if (!folder) return setError('Choose a folder for the images.');
    if (!indices.length) return setError(rangeError || 'Choose at least one page.');
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ done: 0, total: indices.length });
    let written = 0;
    try {
      const write = async (bytes: ArrayBuffer, index: number) => {
        await window.garnet.p4b.writeFile({
          token: folder.token,
          name: name(index),
          bytes,
          kind: format,
        });
        written++;
        setProgress({ done: written, total: indices.length });
      };
      if (indices.length === 1) {
        const page = tab.info.pages[indices[0]];
        const image = await ctx.engine.call('export.renderPage', {
          docId,
          pageId: page.id,
          dpi,
          format,
          quality,
        });
        await write(image.bytes, indices[0]);
      } else {
        const hiddenLayers = (await ctx.engine.call('layers.list', { docId }))
          .filter((layer) => !layer.visible)
          .map((layer) => layer.index);
        await withIsolatedCopy(ctx, docId, async (client, copy) => {
          for (const index of indices) {
            if (controller.signal.aborted) throw new Error('CANCELLED');
            const image = await client.call(
              'export.renderPage',
              {
                docId: copy.docId,
                pageId: copy.pages[index].id,
                dpi,
                format,
                quality,
                hiddenLayers,
              },
              { signal: controller.signal },
            );
            await write(image.bytes, index);
          }
        });
      }
      ctx.ui.toast(`Exported ${plural(written, 'image')} to ${folder.name}.`);
      close();
    } catch (cause) {
      setProgress(null);
      if (controller.signal.aborted || String(cause).includes('CANCELLED'))
        ctx.ui.toast(`Export cancelled after ${plural(written, 'image')}.`);
      else setError(errorText(cause));
    }
  };
  if (progress)
    return (
      <div className="p4b-form" data-testid="export-images-dialog">
        <Progress
          label="Exporting pages"
          done={progress.done}
          total={progress.total}
          onCancel={() => abort.current?.abort()}
        />
      </div>
    );
  return (
    <div className="p4b-form" data-testid="export-images-dialog">
      <section className="p4b-section">
        <Field label="Format">
          <span className="segmented" role="group" aria-label="Format">
            <button type="button" aria-pressed={format === 'png'} onClick={() => setFormat('png')}>
              PNG
            </button>
            <button
              type="button"
              aria-pressed={format === 'jpeg'}
              onClick={() => setFormat('jpeg')}
            >
              JPEG
            </button>
          </span>
        </Field>
        <Field label="Resolution">
          <select
            aria-label="Resolution"
            value={dpi}
            onChange={(e) => setDpi(Number(e.target.value))}
          >
            {[72, 96, 150, 200, 300, 600].map((value) => (
              <option key={value} value={value}>
                {value} dpi{value === 150 ? ' (screen and email)' : value === 300 ? ' (print)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {format === 'jpeg' && (
          <Field label={`JPEG quality ${quality}`}>
            <input
              type="range"
              aria-label="JPEG quality"
              min={10}
              max={100}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </Field>
        )}
        <PagePicker
          scope={scope}
          setScope={setScope}
          range={range}
          setRange={setRange}
          count={tab.info.pageCount}
        />
      </section>
      <section className="p4b-section">
        <Field label="Folder">
          <span className="p4b-row">
            <button
              type="button"
              onClick={() =>
                void window.garnet.p4b
                  .pickFolder()
                  .then((picked) => picked && setFolder(picked))
                  .catch((cause) => setError(errorText(cause)))
              }
            >
              Choose folder
            </button>
            <span className={folder ? '' : 'muted'} data-testid="export-folder">
              {folder ? folder.name : 'No folder chosen'}
            </span>
          </span>
        </Field>
        <Field label="File names">
          <input
            aria-label="File name pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
        </Field>
        <p className="p4b-hint">
          Use {'{name}'} for the document name, {'{page}'} for the page number and {'{label}'} for
          the page label. Example: {indices.length ? name(indices[0]) : name(0)}. Existing files are
          never replaced.
        </p>
      </section>
      {(error || rangeError) && (
        <p className="p4b-error" role="alert">
          {error || rangeError}
        </p>
      )}
      <footer>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!indices.length}
          onClick={() => void run()}
        >
          {indices.length > 1 ? `Export ${indices.length} pages` : 'Export page'}
        </button>
      </footer>
    </div>
  );
}

function PdfForm({ ctx, docId, close }: { ctx: PluginContext; docId: string; close: () => void }) {
  const tab = tabFor(docId)!;
  const [scope, setScope] = useState<Scope>('current');
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { indices, error: rangeError } = usePages(docId, scope, range);
  const run = async () => {
    if (!indices.length) return setError(rangeError || 'Choose at least one page.');
    setBusy(true);
    setError('');
    try {
      const out = await withIsolatedCopy(ctx, docId, (client, copy) =>
        client.call('export.extractPages', {
          docId: copy.docId,
          pageIds: indices.map((index) => copy.pages[index].id),
        }),
      );
      const label = indices.length === 1 ? `page ${indices[0] + 1}` : `${indices.length} pages`;
      const saved = await window.garnet.p4b.saveAs({
        suggestedName: `${safeBaseName(tab.file.name)} (${label}).pdf`,
        bytes: out.bytes,
        kind: 'pdf',
        expectedPageCount: out.pageCount,
      });
      if (saved) {
        ctx.ui.toast(`Saved ${plural(out.pageCount, 'page')} as ${saved.name}.`);
        close();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="p4b-form" data-testid="export-pdf-dialog">
      <PagePicker
        scope={scope}
        setScope={setScope}
        range={range}
        setRange={setRange}
        count={tab.info.pageCount}
      />
      <p className="p4b-hint">
        The chosen pages are copied into a new PDF in document order. This document is not changed.
      </p>
      {(error || rangeError) && (
        <p className="p4b-error" role="alert">
          {error || rangeError}
        </p>
      )}
      <footer>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !indices.length}
          onClick={() => void run()}
        >
          Save as PDF
        </button>
      </footer>
    </div>
  );
}

/** A one-page blank PDF, only used to start a scratch engine worker. */
function blankPdf(): ArrayBuffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
}

interface ImageItem {
  id: number;
  name: string;
  bytes: ArrayBuffer;
}

function ImageRow({
  item,
  index,
  count,
  move,
  remove,
  onDragStart,
  onDrop,
}: {
  item: ImageItem;
  index: number;
  count: number;
  move: (from: number, to: number) => void;
  remove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const url = useObjectUrl(item.bytes, 'image/*');
  const [broken, setBroken] = useState(false);
  return (
    <div
      className="p4b-list-item"
      role="listitem"
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <span className="p4b-page-tag">{index + 1}</span>
      {url && !broken ? (
        <img className="p4b-thumb" src={url} alt="" onError={() => setBroken(true)} />
      ) : (
        <FileImage size={20} className="p4b-thumb" />
      )}
      <span className="p4b-grow">{item.name}</span>
      <span className="p4b-count">{formatBytes(item.bytes.byteLength)}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={`Move ${item.name} up`}
        disabled={index === 0}
        onClick={() => move(index, index - 1)}
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Move ${item.name} down`}
        disabled={index === count - 1}
        onClick={() => move(index, index + 1)}
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Remove ${item.name}`}
        onClick={remove}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function FromImagesForm({ ctx, close }: { ctx: PluginContext; close: () => void }) {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [pageSize, setPageSize] = useState<PageSizeId>('a4');
  const [margin, setMargin] = useState(18);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dragged = useRef<number | null>(null);
  const nextId = useRef(1);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    setItems(next);
  };
  const add = async () => {
    try {
      const picked = await window.garnet.p4b.pickFiles({ purpose: 'images' });
      setItems([
        ...items,
        ...picked.map((file) => ({ id: nextId.current++, name: file.name, bytes: file.bytes })),
      ]);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const create = async () => {
    if (!items.length) return setError('Add at least one image.');
    setBusy(true);
    setError('');
    const client = createEngineClient();
    try {
      const scratch = await client.call('core.open', { bytes: blankPdf() });
      const result = await client.call('export.buildFromImages', {
        docId: scratch.docId,
        images: items.map(({ name, bytes }) => ({ name, bytes: bytes.slice(0) })),
        pageSize,
        margin: pageSize === 'fit' ? 0 : margin,
      });
      if (!shell.openBytes) throw new Error('Opening new documents is not available.');
      await shell.openBytes(result.bytes, `${safeBaseName(items[0].name)}.pdf`);
      ctx.ui.toast(
        result.failed.length
          ? `Created a PDF with ${plural(result.pageCount, 'page')}. Skipped files that are not images: ${result.failed.join(', ')}.`
          : `Created a PDF with ${plural(result.pageCount, 'page')}. Save it to keep it.`,
      );
      close();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      client.terminate();
      setBusy(false);
    }
  };
  return (
    <div className="p4b-form p4b-wide" data-testid="images-to-pdf-dialog">
      <div className="p4b-row">
        <button type="button" onClick={() => void add()}>
          <Images size={16} />
          Add images
        </button>
        <span className="muted">
          {items.length
            ? `${plural(items.length, 'image')}. Drag or use the arrows to change the order.`
            : 'PNG, JPEG, TIFF, GIF, BMP and WebP images.'}
        </span>
      </div>
      {items.length > 0 && (
        <div className="p4b-list" role="list" aria-label="Images">
          {items.map((item, index) => (
            <ImageRow
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              move={move}
              remove={() => setItems(items.filter((other) => other.id !== item.id))}
              onDragStart={() => (dragged.current = index)}
              onDrop={() => dragged.current !== null && move(dragged.current, index)}
            />
          ))}
        </div>
      )}
      <section className="p4b-section">
        <Field label="Page size">
          <select
            aria-label="Page size"
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value as PageSizeId)}
          >
            <option value="fit">Same as each image</option>
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </select>
        </Field>
        <Field label="Margin">
          <select
            aria-label="Margin"
            value={margin}
            disabled={pageSize === 'fit'}
            onChange={(e) => setMargin(Number(e.target.value))}
          >
            <option value={0}>None</option>
            <option value={18}>Small (6 mm)</option>
            <option value={36}>Medium (13 mm)</option>
            <option value={72}>Large (25 mm)</option>
          </select>
        </Field>
        <p className="p4b-hint">
          Photos are turned the right way up. Images are never enlarged beyond their own size on A4
          or Letter pages.
        </p>
      </section>
      {error && (
        <p className="p4b-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !items.length}
          onClick={() => void create()}
        >
          Create PDF
        </button>
      </footer>
    </div>
  );
}

export default definePlugin({
  id: 'export',
  name: 'Export',
  version: '1.0.0',
  activate(ctx) {
    const hasDocument = () => !!ctx.documents.active();
    const withDoc = (title: string, Form: typeof ImagesForm) => async () => {
      const doc = ctx.documents.active();
      if (doc)
        await openDialog<void>(title, (close) => (
          <Form ctx={ctx} docId={doc.docId} close={close} />
        ));
    };
    const disposers = [
      ctx.commands.register({
        id: 'export.pagesAsImages',
        title: 'Export pages as images',
        icon: FileImage,
        enabled: hasDocument,
        run: withDoc('Export pages as images', ImagesForm),
      }),
      ctx.commands.register({
        id: 'export.pagesAsPdf',
        title: 'Save pages as PDF',
        icon: FileOutput,
        enabled: hasDocument,
        run: withDoc('Save pages as PDF', PdfForm),
      }),
      ctx.commands.register({
        id: 'export.imagesToPdf',
        title: 'Create PDF from images',
        icon: Images,
        run: async () => {
          await openDialog<void>('Create PDF from images', (close) => (
            <FromImagesForm ctx={ctx} close={close} />
          ));
        },
      }),
      ctx.toolbar.addItem('Tools', {
        id: 'export.pagesAsImages',
        command: 'export.pagesAsImages',
        label: 'Export images',
      }),
      ctx.toolbar.addItem('Tools', {
        id: 'export.pagesAsPdf',
        command: 'export.pagesAsPdf',
        label: 'Save pages as PDF',
      }),
      ctx.toolbar.addItem('Tools', {
        id: 'export.imagesToPdf',
        command: 'export.imagesToPdf',
        label: 'PDF from images',
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  },
});
