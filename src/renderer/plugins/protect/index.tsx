import {
  Eraser,
  Lock,
  LockOpen,
  ScanSearch,
  ShieldAlert,
  SquareDashed,
  TextSelect,
} from 'lucide-react';
import { definePlugin } from '../../plugin-host/types';
import { useApp } from '../../store';
import { addPassword, removePassword } from './password';
import { applyRedactions, findAndRedact, thumbnailRefresh } from './redact';
import { sanitizeDocument } from './sanitize';
import {
  AREA_TOOL,
  areaTool,
  markSelection,
  refreshRecentThumbnail,
  watchSelection,
} from './marking';
import { errorText } from './kit';

export default definePlugin({
  id: 'protect',
  name: 'Protect and redact',
  version: '1.0.0',
  activate(ctx) {
    const hasDocument = () => !!ctx.documents.active();
    const guard = (run: () => Promise<void>) => () =>
      run().catch((error) => ctx.ui.toast(errorText(error)));
    const commands = [
      {
        id: 'protect.addPassword',
        title: 'Add password',
        label: 'Add password',
        icon: Lock,
        run: guard(() => addPassword(ctx)),
      },
      {
        id: 'protect.removePassword',
        title: 'Remove password',
        label: 'Remove password',
        icon: LockOpen,
        run: guard(() => removePassword(ctx)),
      },
      {
        id: 'protect.markArea',
        title: 'Mark area for redaction',
        label: 'Mark area',
        icon: SquareDashed,
        run: () => {
          const active = ctx.tools.active() === AREA_TOOL;
          ctx.tools.activate(active ? null : AREA_TOOL);
          ctx.ui.toast(
            active
              ? 'Mark area is off.'
              : 'Drag over the page to mark an area. Press Escape to stop.',
          );
        },
      },
      {
        id: 'protect.markSelection',
        title: 'Mark selected text for redaction',
        label: 'Mark selection',
        icon: TextSelect,
        run: guard(() => markSelection(ctx)),
      },
      {
        id: 'protect.findRedact',
        title: 'Find and redact',
        label: 'Find and redact',
        icon: ScanSearch,
        run: guard(() => findAndRedact(ctx)),
      },
      {
        id: 'protect.apply',
        title: 'Apply redactions',
        label: 'Apply redactions',
        icon: Eraser,
        run: guard(() => applyRedactions(ctx)),
      },
      {
        id: 'protect.sanitize',
        title: 'Sanitize document',
        label: 'Sanitize',
        icon: ShieldAlert,
        run: guard(() => sanitizeDocument(ctx)),
      },
    ];
    const disposers = commands.flatMap(({ label, ...command }) => [
      ctx.commands.register({ ...command, enabled: hasDocument }),
      ctx.toolbar.addItem('Protect', { id: command.id, command: command.id, label }),
    ]);
    disposers.push(ctx.tools.register(areaTool(ctx)), watchSelection(ctx));
    const stopTool = () => {
      if (ctx.tools.active() === AREA_TOOL) ctx.tools.activate(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopTool();
    };
    window.addEventListener('keydown', onKey);
    disposers.push(() => window.removeEventListener('keydown', onKey));
    disposers.push(
      useApp.subscribe((state, previous) => {
        if (state.mode !== previous.mode || state.activeId !== previous.activeId) stopTool();
      }),
    );
    disposers.push(
      ctx.documents.subscribe('saved', (doc) => {
        if (thumbnailRefresh.delete(doc.docId))
          void refreshRecentThumbnail(ctx, doc.docId).catch(() => {});
      }),
    );
    return () => disposers.forEach((dispose) => dispose());
  },
});
