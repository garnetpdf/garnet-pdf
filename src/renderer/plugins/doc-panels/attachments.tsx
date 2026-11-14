import { useEffect, useState } from 'react';
import { Download, Eye, EyeOff, Paperclip, Trash2 } from 'lucide-react';
import type { PluginContext } from '../../plugin-host/types';
import { useApp } from '../../store';
import { EmptyState, IconButton } from '../../ui';
import type { AttachmentInfo } from '../../../engine/ops/attachments';
import type { LayerInfo } from '../../../engine/ops/layers';
import { formatBytes } from '../../../engine/tools/optimize/presets';
import { errorText, plural, useRevision } from '../protect/kit';

function useActiveDoc() {
  const docId = useApp((state) => state.activeId) ?? undefined;
  return { docId, revision: useRevision(docId) };
}

export function AttachmentsPanel({ ctx }: { ctx: PluginContext }) {
  const { docId, revision } = useActiveDoc();
  const [items, setItems] = useState<AttachmentInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!docId) return;
    let live = true;
    ctx.engine.call('attachments.list', { docId }).then(
      (next) => live && setItems(next),
      (error) => ctx.ui.toast(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, [docId, revision]);
  if (!docId) return null;
  const current = items.find((item) => item.id === selected);
  const add = async () => {
    try {
      const files = await window.garnet.p4b.pickFiles({ purpose: 'any' });
      if (!files.length) return;
      await ctx.history.run(
        files.length === 1 ? `Attach ${files[0].name}` : `Attach ${files.length} files`,
        async () => {
          for (const file of files)
            await ctx.engine.call('attachments.add', { docId, name: file.name, bytes: file.bytes });
        },
      );
      ctx.ui.toast(
        `Attached ${plural(files.length, 'file')}. Save to keep ${files.length === 1 ? 'it' : 'them'}.`,
      );
    } catch (error) {
      ctx.ui.toast(errorText(error));
    }
  };
  const saveAs = async () => {
    if (!current) return;
    try {
      const file = await ctx.engine.call('attachments.read', { docId, id: current.id });
      const saved = await window.garnet.p4b.saveAs({
        suggestedName: file.name,
        bytes: file.bytes,
        kind: 'any',
      });
      if (saved) ctx.ui.toast(`Saved ${saved.name}.`);
    } catch (error) {
      ctx.ui.toast(errorText(error));
    }
  };
  const remove = async () => {
    if (!current || !(await ctx.ui.confirm(`Delete the attached file ${current.name}?`))) return;
    try {
      await ctx.engine.call('attachments.remove', { docId, id: current.id });
      setSelected(null);
    } catch (error) {
      ctx.ui.toast(errorText(error));
    }
  };
  return (
    <div className="p4b-panel" data-testid="attachments-panel">
      <div className="p4b-panel-toolbar" role="toolbar" aria-label="Attachment actions">
        <IconButton label="Attach files" onClick={() => void add()}>
          <Paperclip size={15} />
        </IconButton>
        <IconButton label="Save attachment as" disabled={!current} onClick={() => void saveAs()}>
          <Download size={15} />
        </IconButton>
        <IconButton label="Delete attachment" disabled={!current} onClick={() => void remove()}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      {!items.length ? (
        <EmptyState>No attached files. Choose Attach files to add one.</EmptyState>
      ) : (
        <div className="p4b-panel-body" role="listbox" aria-label="Attached files">
          {items.map((item) => (
            <div
              key={item.id}
              role="option"
              tabIndex={0}
              aria-selected={selected === item.id}
              className="p4b-tree-row"
              style={{ paddingInlineStart: 8 }}
              title={item.description || item.name}
              onClick={() => setSelected(item.id)}
              onDoubleClick={() => void saveAs()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setSelected(item.id);
              }}
            >
              <Paperclip size={14} />
              <span className="p4b-title">{item.name}</span>
              <span className="p4b-page-tag">
                {item.pageIndex !== null ? `Page ${item.pageIndex + 1} · ` : ''}
                {formatBytes(item.size)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function LayersPanel({ ctx }: { ctx: PluginContext }) {
  const { docId, revision } = useActiveDoc();
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  useEffect(() => {
    if (!docId) return;
    let live = true;
    ctx.engine.call('layers.list', { docId }).then(
      (next) => live && setLayers(next),
      (error) => ctx.ui.toast(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, [docId, revision]);
  if (!docId) return null;
  return (
    <div className="p4b-panel" data-testid="layers-panel">
      {!layers.length ? (
        <EmptyState>This document has no layers.</EmptyState>
      ) : (
        <div className="p4b-panel-body" role="list" aria-label="Layers">
          {layers.map((layer) => (
            <label key={layer.index} className="p4b-layer" role="listitem">
              <input
                type="checkbox"
                checked={layer.visible}
                aria-label={`Show ${layer.name}`}
                onChange={(event) => {
                  // Show the new state at once; the engine confirms it and the list reloads on the next revision.
                  const visible = event.target.checked;
                  setLayers((current) =>
                    current.map((item) =>
                      item.index === layer.index ? { ...item, visible } : item,
                    ),
                  );
                  void ctx.engine
                    .call('layers.setVisible', { docId, index: layer.index, visible })
                    .catch((error) => {
                      ctx.ui.toast(errorText(error));
                      setLayers((current) =>
                        current.map((item) =>
                          item.index === layer.index ? { ...item, visible: !visible } : item,
                        ),
                      );
                    });
                }}
              />
              {layer.visible ? <Eye size={14} /> : <EyeOff size={14} className="muted" />}
              <span className="p4b-title">{layer.name}</span>
            </label>
          ))}
          <p className="p4b-hint" style={{ padding: '8px' }}>
            Hidden layers are left out on screen, in printing and in exported images. This is a
            viewing setting and is not saved in the file.
          </p>
        </div>
      )}
    </div>
  );
}
