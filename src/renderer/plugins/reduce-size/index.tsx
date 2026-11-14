import { useEffect, useRef, useState } from 'react';
import { Shrink } from 'lucide-react';
import { definePlugin, type PluginContext } from '../../plugin-host/types';
import type { ReduceResult } from '../../../engine/ops/optimize';
import {
  formatBytes,
  PRESETS,
  settingsProblem,
  type PresetId,
  type ReduceSettings,
} from '../../../engine/tools/optimize/presets';
import {
  Check,
  errorText,
  Field,
  openDialog,
  Progress,
  tabFor,
  withIsolatedCopy,
} from '../protect/kit';

type Stage =
  | { kind: 'settings' }
  | { kind: 'running'; phase: string; done: number; total: number }
  | { kind: 'done'; result: ReduceResult; applied: boolean };

function strip({
  label: _label,
  hint: _hint,
  ...settings
}: (typeof PRESETS)[keyof typeof PRESETS]): ReduceSettings {
  return settings;
}

function ReduceForm({
  ctx,
  docId,
  close,
}: {
  ctx: PluginContext;
  docId: string;
  close: () => void;
}) {
  const [preset, setPreset] = useState<PresetId>('balanced');
  const [settings, setSettings] = useState<ReduceSettings>(strip(PRESETS.balanced));
  const [stage, setStage] = useState<Stage>({ kind: 'settings' });
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const tab = tabFor(docId);
  const fileSize = tab && !tab.info.dirty && tab.file.handle ? tab.file.size : undefined;
  const choose = (id: PresetId) => {
    setPreset(id);
    if (id !== 'custom') setSettings(strip(PRESETS[id]));
  };
  const update = (patch: Partial<ReduceSettings>) => {
    setPreset('custom');
    setSettings({ ...settings, ...patch });
  };
  const run = async () => {
    const problem = settingsProblem(settings);
    if (problem) return setError(problem);
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    setStage({ kind: 'running', phase: 'Preparing a copy', done: 0, total: 0 });
    try {
      const result = await withIsolatedCopy(ctx, docId, (client, copy, size) =>
        client.call(
          'optimize.reduce',
          { docId: copy.docId, settings, baselineSize: fileSize ?? size },
          {
            signal: controller.signal,
            onProgress: (data) => {
              const p = data as { phase: string; done: number; total: number };
              setStage({ kind: 'running', phase: p.phase, done: p.done, total: p.total });
            },
          },
        ),
      );
      if (controller.signal.aborted) throw new Error('CANCELLED');
      if (!result.kept) {
        setStage({ kind: 'running', phase: 'Updating the document', done: 0, total: 0 });
        await ctx.engine.call('optimize.apply', {
          docId,
          settings,
          replacements: result.replacements,
        });
      }
      setStage({ kind: 'done', result, applied: !result.kept });
    } catch (cause) {
      setStage({ kind: 'settings' });
      if (!controller.signal.aborted && !String(cause).includes('CANCELLED'))
        setError(errorText(cause));
    }
  };
  if (stage.kind === 'running')
    return (
      <div className="p4b-form" data-testid="reduce-size-dialog">
        <Progress
          label={stage.phase}
          done={stage.done}
          total={stage.total}
          onCancel={() => abort.current?.abort()}
        />
        <p className="p4b-hint">The open document is not changed until the result is ready.</p>
      </div>
    );
  if (stage.kind === 'done') {
    const { result } = stage;
    const saved = result.beforeSize - result.afterSize;
    return (
      <div className="p4b-form" data-testid="reduce-size-dialog">
        <div className="p4b-sizes" data-testid="reduce-size-result">
          <div className="p4b-stat">
            <span>Before</span>
            <strong>{formatBytes(result.beforeSize)}</strong>
          </div>
          <div className="p4b-stat">
            <span>After</span>
            <strong>{formatBytes(result.afterSize)}</strong>
          </div>
          <div className="p4b-stat">
            <span>Saved</span>
            <strong>
              {result.kept ? '0%' : `${Math.round((saved / result.beforeSize) * 100)}%`}
            </strong>
          </div>
        </div>
        <p className="p4b-hint">
          {result.kept
            ? 'This file is already as small as these settings allow. Nothing was changed.'
            : `${result.imagesReplaced ? `${result.imagesReplaced} of ${result.imagesFound} images were compressed. ` : ''}Save the document to keep the smaller file. Undo restores the original.`}
        </p>
        <footer>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    );
  }
  return (
    <div className="p4b-form" data-testid="reduce-size-dialog">
      <div className="segmented" role="group" aria-label="Preset">
        {(['high', 'balanced', 'smallest', 'custom'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={preset === id} onClick={() => choose(id)}>
            {id === 'custom' ? 'Custom' : PRESETS[id].label}
          </button>
        ))}
      </div>
      <p className="p4b-hint">
        {preset === 'custom' ? 'Your own settings.' : PRESETS[preset].hint}
      </p>
      <section className="p4b-section">
        <h3>Images</h3>
        <Field label="Downsample above">
          <span className="p4b-row">
            <input
              type="number"
              aria-label="Threshold resolution"
              min={36}
              max={2400}
              value={settings.thresholdDpi}
              style={{ width: 90 }}
              onChange={(e) => update({ thresholdDpi: Number(e.target.value) })}
            />
            <span className="muted">dpi, to</span>
            <input
              type="number"
              aria-label="Target resolution"
              min={36}
              max={1200}
              value={settings.targetDpi}
              style={{ width: 90 }}
              onChange={(e) => update({ targetDpi: Number(e.target.value) })}
            />
            <span className="muted">dpi</span>
          </span>
        </Field>
        <Field label={`JPEG quality ${settings.jpegQuality}`}>
          <input
            type="range"
            aria-label="JPEG quality"
            min={10}
            max={100}
            value={settings.jpegQuality}
            onChange={(e) => update({ jpegQuality: Number(e.target.value) })}
          />
        </Field>
        <Check
          checked={settings.convertLossless}
          onChange={(convertLossless) => update({ convertLossless })}
          label="Compress lossless photos as JPEG"
          help="Images with transparency stay lossless. Images under 20 KB are left as they are."
        />
        <Check
          checked={settings.grayscale}
          onChange={(grayscale) => update({ grayscale })}
          label="Convert images to grayscale"
        />
      </section>
      <section className="p4b-section">
        <h3>Document</h3>
        <Check
          checked={settings.subsetFonts}
          onChange={(subsetFonts) => update({ subsetFonts })}
          label="Keep only the font characters that are used"
        />
        <Check
          checked={settings.removeMetadata}
          onChange={(removeMetadata) => update({ removeMetadata })}
          label="Remove document information (metadata)"
        />
        <Check
          checked={settings.removeThumbnails}
          onChange={(removeThumbnails) => update({ removeThumbnails })}
          label="Remove embedded page thumbnails"
        />
        <Check
          checked={settings.removeAttachments}
          onChange={(removeAttachments) => update({ removeAttachments })}
          label="Remove attached files"
        />
        <p className="p4b-hint">
          Unused objects are always removed and objects are packed together when the file is saved.
        </p>
      </section>
      <p className="p4b-hint">
        Current size:{' '}
        {fileSize !== undefined
          ? formatBytes(fileSize)
          : 'measured when you start (unsaved changes)'}
      </p>
      {error && (
        <p className="p4b-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => void run()}>
          Reduce file size
        </button>
      </footer>
    </div>
  );
}

export default definePlugin({
  id: 'reduce-size',
  name: 'Reduce file size',
  version: '1.0.0',
  activate(ctx) {
    const disposers = [
      ctx.commands.register({
        id: 'tools.reduceSize',
        title: 'Reduce file size',
        icon: Shrink,
        enabled: () => !!ctx.documents.active(),
        run: async () => {
          const doc = ctx.documents.active();
          if (!doc) return;
          await openDialog<void>('Reduce file size', (close) => (
            <ReduceForm ctx={ctx} docId={doc.docId} close={close} />
          ));
        },
      }),
      ctx.toolbar.addItem('Tools', {
        id: 'tools.reduceSize',
        command: 'tools.reduceSize',
        label: 'Reduce file size',
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  },
});
