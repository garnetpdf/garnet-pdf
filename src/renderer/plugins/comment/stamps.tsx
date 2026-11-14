/** Stamp picker: standard stamps plus custom image stamps kept in the encrypted local store. */
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { BUILTIN_STAMPS, toCss, type StampChoice } from './toolstate';
import { addSignItem, loadSignStore, removeSignItem, useSignStore } from '../fill-sign/store';
import { prepareImage } from '../fill-sign/raster';
import { browserRaster } from '../fill-sign/browser-raster';

export function StampPicker({ onPick, close }: { onPick: (stamp: StampChoice) => void; close: () => void }) {
  const all = useSignStore((s) => s.items);
  const persistent = useSignStore((s) => s.persistent);
  const reason = useSignStore((s) => s.reason);
  const custom = all.filter((i) => i.kind === 'stamp');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void loadSignStore();
  }, []);
  const pick = (stamp: StampChoice) => {
    onPick(stamp);
    close();
  };
  const importImage = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      if (picked.size > 15 * 1024 * 1024) throw new Error('This picture is too large (over 15 MB).');
      const image = await prepareImage(browserRaster, await picked.arrayBuffer(), { removeWhite: false, maxSide: 1200 });
      const name = picked.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Stamp';
      const { item } = await addSignItem({ kind: 'stamp', name, ...image }, true);
      pick({ label: name, imageId: item.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <div className="stamp-picker">
      <div className="stamp-grid" role="group" aria-label="Standard stamps">
        {BUILTIN_STAMPS.map((stamp) => (
          <button
            key={stamp.icon}
            className="stamp-choice"
            style={{ color: toCss(stamp.color), borderColor: toCss(stamp.color) }}
            onClick={() => pick(stamp)}
          >
            {stamp.label.toUpperCase()}
          </button>
        ))}
      </div>
      <h3 className="stamp-heading">Custom stamps</h3>
      {custom.length ? (
        <div className="stamp-custom-list" role="group" aria-label="Custom stamps">
          {custom.map((item) => (
            <div key={item.id} className="stamp-custom">
              <button className="stamp-custom-pick" onClick={() => pick({ label: item.name, imageId: item.id })} title={item.name}>
                <img src={`data:image/png;base64,${item.png}`} alt={item.name} />
              </button>
              <button
                className="icon-button"
                aria-label={`Delete stamp ${item.name}`}
                title="Delete stamp"
                onClick={() => void removeSignItem(item.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted stamp-empty">Use a picture of your company stamp or seal (PNG or JPEG).</p>
      )}
      <div className="stamp-actions">
        <button onClick={() => file.current?.click()} disabled={busy}>
          <ImagePlus size={15} />
          {busy ? 'Importing…' : 'Import picture'}
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg"
          aria-label="Stamp picture file"
          hidden
          onChange={(e) => void importImage(e.target.files?.[0])}
        />
      </div>
      {!persistent && (
        <p className="muted stamp-note">
          {reason || 'Custom stamps cannot be stored on this computer.'} Imported stamps are kept until you close the app.
        </p>
      )}
      {error && (
        <p className="annot-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
