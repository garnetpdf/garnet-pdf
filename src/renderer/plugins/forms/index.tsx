/**
 * Form filling in View mode: when the document has fields, they become real inputs over the page.
 * Values are written through the engine (one undo step each) with regenerated appearances.
 * PDF scripts never run; with "Enable PDF JavaScript" on, only simple sum/average/min/max/product
 * totals are calculated by the app itself.
 */
import type { EditPage } from '../../plugin-host/types';
import { definePlugin } from '../../plugin-host/types';
import { useApp } from '../../store';
import { FormsLayer } from './FormsLayer';
import { connectForms, onFormsLoaded, useForms } from './store';
import './forms.css';

const FillOverlay = ({ page }: { page: EditPage }) => <FormsLayer page={page} />;
const fillable = () => useForms.getState().widgets.some((w) => !w.hidden && w.type !== 'button');

export default definePlugin({
  id: 'forms',
  name: 'Forms',
  version: '1.0.0',
  activate(ctx) {
    const disposers: (() => void)[] = [connectForms(ctx, 'forms')];
    ctx.tools.register({ id: 'forms.fill', cursor: 'default', overlay: FillOverlay });
    let queued = false;
    const sync = () => {
      if (queued) return;
      queued = true;
      // After other plugins have reacted to the same mode change.
      queueMicrotask(() => {
        queued = false;
        const mode = useApp.getState().mode;
        const active = ctx.tools.active();
        if (mode === 'View' && fillable() && !active) ctx.tools.activate('forms.fill');
        else if ((mode !== 'View' || !fillable()) && active === 'forms.fill') ctx.tools.activate(null);
      });
    };
    disposers.push(
      useApp.subscribe((s, previous) => {
        if (s.mode !== previous.mode || s.activeId !== previous.activeId) sync();
      }),
      useForms.subscribe((s, previous) => {
        if (s.widgets !== previous.widgets) sync();
      }),
      onFormsLoaded(() => {
        const state = useForms.getState();
        if (!state.hasScripts) return;
        ctx.ui.toast(
          'This document contains scripts. For your safety they never run here, so automatic formatting or checks in this form will not happen.',
        );
      }),
    );
    sync();
    return () => {
      if (ctx.tools.active() === 'forms.fill') ctx.tools.activate(null);
      disposers.reverse().forEach((d) => d());
    };
  },
});
