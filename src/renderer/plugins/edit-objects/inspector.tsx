import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, ColorPicker, NumberInput, Slider, Tooltip } from '../../ui';
import type { SelectionItem } from '../../plugin-host/types';
import { ObjectsController, type ObjectData } from './controller';
import { bounds, resized, units, type Alignment } from './geometry';
const rgb = (value?: number[]) =>
  '#' +
  (value ?? [0, 0, 0])
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const color = (value: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
export function ObjectActions({
  controller: c,
  compact = false,
}: {
  controller: ObjectsController;
  compact?: boolean;
}) {
  const version = useSyncExternalStore(c.subscribe, c.snapshot);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = root.current?.closest('[role="dialog"]');
    if (!c.busy && dialog && !dialog.contains(document.activeElement))
      root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [c, version]);
  const items = c.own(),
    one = items.length === 1 ? items[0] : null,
    image = one && ['image', 'inline-image'].includes(one.kind);
  const action = (
    label: string,
    cap: Parameters<typeof c.reason>[0],
    fn: () => Promise<unknown> | void,
  ) => {
    const reason = c.reason(cap);
    return (
      <Tooltip key={label} label={reason ?? label}>
        <Button disabled={!!reason} title={reason ?? label} onClick={() => void c.run(fn)}>
          {label}
        </Button>
      </Tooltip>
    );
  };
  return (
    <div ref={root} className={compact ? 'objects-menu-actions' : 'objects-actions'}>
      {image && (
        <>
          {action('Replace image', 'replace', () => c.replace())}
          {action('Replace from clipboard', 'replace', () => c.clipboard(true))}
          {action('Crop image', 'crop', () => c.beginCrop())}
          {action('Extract image', 'extract', () => c.extract())}
        </>
      )}
      {action('Rotate left', 'move', () => c.rotate(-90))}
      {action('Rotate right', 'move', () => c.rotate(90))}
      {action('Flip horizontal', 'move', () => c.rotate(0, 'horizontal'))}
      {action('Flip vertical', 'move', () => c.rotate(0, 'vertical'))}
      {(['front', 'forward', 'backward', 'back'] as const).map((direction, i) =>
        action(['Bring to front', 'Forward', 'Backward', 'Send to back'][i], 'reorder', () =>
          c.edit({ type: 'reorder', ids: items.map((s) => s.id), direction }),
        ),
      )}
      {one?.kind === 'form' &&
        action('Edit contents', 'editForm', () => c.edit({ type: 'expandForm', id: one.id }))}
      {action('Delete object', 'delete', () =>
        c.edit({ type: 'delete', ids: items.map((s) => s.id) }),
      )}
    </div>
  );
}
export function Inspector({
  controller: c,
  selection,
}: {
  controller: ObjectsController;
  selection: SelectionItem[];
}) {
  useSyncExternalStore(c.subscribe, c.snapshot);
  // The host mounts one inspector per object; render the combined inspector once.
  const own = c.own();
  const [unit, setUnit] = useState<keyof typeof units>('pt'),
    [lock, setLock] = useState(true);
  const [alpha, setAlpha] = useState<number | null>(null);
  if (!own.length || selection[0]?.id !== own[0].id) return null;
  const box = bounds(own.map((s) => s.bounds)),
    single = own.length === 1 ? own[0] : null,
    data = single?.data as ObjectData | undefined;
  const width = box[2] - box[0],
    height = box[3] - box[1],
    factor = units[unit];
  const image = single && ['image', 'inline-image'].includes(single.kind);
  const moveReason = c.reason('move');
  const transform = (matrix: Parameters<typeof c.transform>[1]) =>
    c.run(async () => {
      const page = c.page();
      if (page) await c.transform(own, matrix, page);
    });
  const dimension = (label: string, value: number, apply: (v: number) => void) => (
    <label className="objects-field" key={label}>
      <span>{label}</span>
      <NumberInput
        aria-label={label}
        title={moveReason}
        disabled={!!moveReason}
        unit={unit}
        step="0.1"
        key={`${label}:${value}:${unit}`}
        defaultValue={Number((value / factor).toFixed(3))}
        onBlur={(e) => {
          const next = Number(e.target.value) * factor;
          if (Number.isFinite(next) && Math.abs(next - value) > 0.0001) apply(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
  let rotation = 0;
  if (data) {
    const m = data.object.ctm;
    rotation = (Math.atan2(-m[1], m[0]) * 180) / Math.PI;
  }
  return (
    <section className="objects-inspector" data-testid="object-inspector">
      <h3>
        {single
          ? image
            ? 'Image'
            : single.kind === 'form'
              ? 'Form'
              : single.kind === 'path'
                ? 'Vector path'
                : 'Shading'
          : `${own.length} objects`}
      </h3>
      <label className="objects-field">
        <span>Units</span>
        <select
          aria-label="Object units"
          value={unit}
          onChange={(e) => setUnit(e.target.value as keyof typeof units)}
        >
          {Object.keys(units).map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </label>
      <div className="objects-fields">
        {dimension('X', box[0], (v) => void transform([1, 0, 0, 1, v - box[0], 0]))}
        {dimension('Y', box[1], (v) => void transform([1, 0, 0, 1, 0, v - box[1]]))}
        {dimension('Width', width, (v) => {
          if (v > 0) void transform(resized(box, v, lock ? (height * v) / width : height));
        })}
        {dimension('Height', height, (v) => {
          if (v > 0) void transform(resized(box, lock ? (width * v) / height : width, v));
        })}
      </div>
      <label className="objects-check">
        <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
        Lock aspect ratio
      </label>
      <label className="objects-field">
        <span>Rotation</span>
        <NumberInput
          aria-label="Rotation"
          unit="°"
          disabled={!!moveReason}
          title={moveReason}
          key={rotation}
          defaultValue={Number(rotation.toFixed(2))}
          onBlur={(e) => {
            const value = Number(e.target.value);
            if (Number.isFinite(value) && Math.abs(value - rotation) > 0.001)
              void c.run(() => c.rotate(value - rotation));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
      <label className="objects-field">
        <span>Opacity</span>
        <Slider
          aria-label="Object opacity"
          title={c.reason('opacity')}
          disabled={!!c.reason('opacity')}
          min="0"
          max="100"
          value={alpha ?? Math.round((data?.object.opacity?.fill ?? 1) * 100)}
          onChange={(e) => setAlpha(Number(e.target.value))}
          onPointerUp={() => {
            if (alpha !== null)
              void c.run(async () => {
                await c.edit({ type: 'opacity', ids: own.map((s) => s.id), alpha: alpha / 100 });
                setAlpha(null);
              });
          }}
          onKeyUp={() => {
            if (alpha !== null)
              void c.run(async () => {
                await c.edit({ type: 'opacity', ids: own.map((s) => s.id), alpha: alpha / 100 });
                setAlpha(null);
              });
          }}
        />
      </label>
      {image && (
        <>
          <label className="objects-field">
            <span>Image fit</span>
            <select
              aria-label="Image fit"
              value={c.fit}
              onChange={(e) => {
                c.fit = e.target.value as typeof c.fit;
                c.emit();
              }}
            >
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="stretch">Stretch</option>
            </select>
          </label>
          <label className="objects-check">
            <input
              type="checkbox"
              aria-label="All uses"
              checked={c.allUses}
              onChange={(e) => {
                c.allUses = e.target.checked;
                c.emit();
              }}
            />
            Replace all uses
          </label>
          {data?.object.image?.replaceRequiresAlpha && (
            <p className="muted">Use a transparent PNG when replacing this image.</p>
          )}
        </>
      )}
      {single?.kind === 'path' && (
        <>
          {(['fill', 'stroke'] as const).map((type) => (
            <label className="objects-field" key={type}>
              <span>{type === 'fill' ? 'Fill' : 'Stroke'}</span>
              <ColorPicker
                aria-label={`${type === 'fill' ? 'Fill' : 'Stroke'} color`}
                disabled={!!c.reason('recolor')}
                title={c.reason('recolor')}
                defaultValue={rgb(data?.object[type])}
                onChange={(e) =>
                  void c.run(() => c.edit({ type, ids: [single.id], color: color(e.target.value) }))
                }
              />
            </label>
          ))}
          <Tooltip label={c.reason('strokeWidth') ?? 'Stroke width'}>
            <label className="objects-field">
              <span>Stroke width</span>
              <NumberInput
                aria-label="Stroke width"
                unit="pt"
                min="0"
                step="0.25"
                disabled={!!c.reason('strokeWidth')}
                title={c.reason('strokeWidth')}
                key={data?.object.lineWidth}
                defaultValue={data?.object.lineWidth ?? 0}
                onBlur={(e) => {
                  const width = Number(e.target.value);
                  if (Number.isFinite(width) && width >= 0 && width !== data?.object.lineWidth)
                    void c.run(() => c.edit({ type: 'strokeWidth', ids: [single.id], width }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </label>
          </Tooltip>
        </>
      )}
      {own.length >= 2 && (
        <>
          <h3>Align selection</h3>
          <div className="objects-actions">
            {(
              [
                'left',
                'centre',
                'right',
                'top',
                'middle',
                'bottom',
                'horizontal',
                'vertical',
              ] as Alignment[]
            ).map((mode) => (
              <Button
                key={mode}
                disabled={!!moveReason}
                onClick={() => void c.run(() => c.align(mode))}
              >
                {['horizontal', 'vertical'].includes(mode) ? `Distribute ${mode}` : `Align ${mode}`}
              </Button>
            ))}
          </div>
        </>
      )}
      <ObjectActions controller={c} />
      {data?.object.editability.reason && <p className="muted">{data.object.editability.reason}</p>}
    </section>
  );
}
