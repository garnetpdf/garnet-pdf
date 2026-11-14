/**
 * Fill & Sign mode: fill form fields, sign with a typed, drawn or imported signature (kept encrypted
 * on this computer when the system allows it), add initials, text, today's date, ticks, crosses and
 * dots, then optionally flatten them into the page. Placed items are annotations marked as
 * Fill & Sign items, so they can be moved and resized until flattened.
 */
import {
  ArrowDownToLine,
  CalendarDays,
  Check,
  Dot,
  Layers,
  PenTool,
  RotateCcw,
  Signature,
  SquareDashed,
  Type,
  X,
} from 'lucide-react';
import { definePlugin, type EditPage } from '../../plugin-host/types';
import type { FillSignKind } from '../../../engine/tools/annots/types';
import { useApp } from '../../store';
import { connectAnnotStore, flattenAnnotations, useAnnots } from '../comment/shared/store';
import { mountDialogRoot, openDialog } from '../comment/shared/ui-root';
import { installAnnotKeys } from '../comment/shared/keys';
import {
  connectForms,
  flattenForm,
  OUTSIDE_STANDARD_FONTS,
  resetForm,
  setHighlight,
  useForms,
  type FormWidget,
} from '../forms/store';
import { loadSignStore, useSignStore, type StoredSignItem } from './store';
import { SignatureDialog, SignaturePicker, type SignKind } from './SignatureDialog';
import { FillSignSelectOverlay, PlaceOverlay, setFillSignApi, signInto, usePlacing } from './tools';
import '../comment/comment.css';
import '../forms/forms.css';
import './fill-sign.css';

const MODE = 'Fill & Sign';
const SELECT = 'fillsign.select';
const PLACE = 'fillsign.place';
const PLACE_TITLES: Record<string, string> = {
  signature: 'Sign',
  initials: 'Initials',
  text: 'Add text',
  date: 'Add date',
  tick: 'Tick',
  cross: 'Cross',
  dot: 'Dot',
};

function markActive(kind: FillSignKind | null) {
  const id = 'garnet-fillsign-active-tool';
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  const title = kind ? PLACE_TITLES[kind] : '';
  style.textContent = title
    ? `.context-toolbar [aria-label='Fill & Sign tools'] button[title="${title}"]{background:var(--accent-soft);color:var(--accent)}`
    : '';
}

export default definePlugin({
  id: 'fill-sign',
  name: 'Fill & Sign',
  version: '1.0.0',
  activate(ctx) {
    const disposers: (() => void)[] = [connectAnnotStore(ctx, 'fill-sign'), connectForms(ctx, 'fill-sign'), mountDialogRoot()];
    const own = (id: string | null) => id === SELECT || id === PLACE;

    const finish = () => {
      usePlacing.setState({ placement: null });
      markActive(null);
      if (useApp.getState().mode === MODE) ctx.tools.activate(SELECT);
    };
    const place = (kind: FillSignKind, item?: StoredSignItem) => {
      const app = useApp.getState();
      if (app.mode !== MODE) app.set({ mode: MODE });
      if (useApp.getState().hand) useApp.getState().set({ hand: false });
      useAnnots.getState().set({ selected: null, popup: null, editing: null });
      usePlacing.setState({ placement: { kind, item } });
      ctx.tools.activate(PLACE);
      markActive(kind);
    };

    const create = (kind: SignKind, then: (item: StoredSignItem) => void) =>
      void openDialog(kind === 'initials' ? 'Create initials' : 'Create signature', (close) => (
        <SignatureDialog kind={kind} close={close} onDone={then} />
      ), { wide: true });
    const choose = async (kind: SignKind, then: (item: StoredSignItem) => void) => {
      await loadSignStore();
      const saved = useSignStore.getState().items.filter((i) => i.kind === kind);
      if (!saved.length) {
        create(kind, then);
        return;
      }
      void openDialog(kind === 'initials' ? 'Your initials' : 'Your signatures', (close) => (
        <SignaturePicker kind={kind} close={close} onPick={then} onCreate={() => create(kind, then)} />
      ));
    };
    setFillSignApi({
      finish,
      signField: (w: FormWidget) => void choose('signature', (item) => void signInto(w, item)),
    });

    const SelectOverlay = ({ page }: { page: EditPage }) => <FillSignSelectOverlay page={page} />;
    ctx.tools.register({ id: SELECT, cursor: 'default', overlay: SelectOverlay });
    ctx.tools.register({ id: PLACE, cursor: 'copy', overlay: PlaceOverlay });

    const hasDoc = () => !!ctx.documents.active();
    const hasFields = () => useForms.getState().widgets.some((w) => w.type !== 'button' && w.type !== 'signature');
    const commands: { id: string; title: string; icon: typeof Signature; run: () => void | Promise<void>; enabled?: () => boolean }[] = [
      { id: 'fillsign.sign', title: 'Sign', icon: Signature, run: () => choose('signature', (item) => place('signature', item)) },
      { id: 'fillsign.initials', title: 'Initials', icon: PenTool, run: () => choose('initials', (item) => place('initials', item)) },
      { id: 'fillsign.text', title: 'Add text', icon: Type, run: () => place('text') },
      { id: 'fillsign.date', title: 'Add date', icon: CalendarDays, run: () => place('date') },
      { id: 'fillsign.tick', title: 'Tick', icon: Check, run: () => place('tick') },
      { id: 'fillsign.cross', title: 'Cross', icon: X, run: () => place('cross') },
      { id: 'fillsign.dot', title: 'Dot', icon: Dot, run: () => place('dot') },
      {
        id: 'fillsign.highlight',
        title: 'Highlight fields',
        icon: SquareDashed,
        run: () => {
          const on = !useForms.getState().highlight;
          setHighlight(on);
          ctx.ui.toast(on ? 'Form fields are highlighted.' : 'Field highlighting is off.');
        },
      },
      {
        id: 'fillsign.reset',
        title: 'Reset form',
        icon: RotateCcw,
        enabled: () => hasDoc() && hasFields(),
        run: async () => {
          if (await ctx.ui.confirm('Clear every form field back to its default value? You can undo this.')) await resetForm();
        },
      },
      {
        id: 'fillsign.flattenForm',
        title: 'Flatten form',
        icon: Layers,
        enabled: () => hasDoc() && hasFields(),
        run: async () => {
          const widgets = useForms.getState().widgets;
          const lists = widgets.some((w) => w.type === 'listbox' && w.values.length);
          const unseen = widgets.some((w) => w.type !== 'listbox' && OUTSIDE_STANDARD_FONTS.test(w.value));
          const message =
            'Flatten the form? The filled values become part of the page and the fields can no longer be edited. You can undo this.' +
            (lists ? ' Selections in list boxes are not shown after flattening.' : '') +
            (unseen
              ? ' Arabic and other text the standard PDF fonts cannot show is left out of flattened fields; add it with Add text instead.'
              : '');
          if (await ctx.ui.confirm(message)) await flattenForm();
        },
      },
      {
        id: 'fillsign.flattenItems',
        title: 'Flatten signatures and text',
        icon: ArrowDownToLine,
        run: async () => {
          const count = useAnnots.getState().items.filter((a) => a.fillSign).length;
          if (!count) {
            ctx.ui.toast('There are no signatures or added text to flatten.');
            return;
          }
          if (
            await ctx.ui.confirm(
              'Flatten your signatures and added text into the page? They can no longer be moved or removed. You can undo this.',
            )
          ) {
            const baked = await flattenAnnotations('fill-sign');
            if (baked) ctx.ui.toast(`${baked} ${baked === 1 ? 'item' : 'items'} flattened into the page.`);
          }
        },
      },
    ];
    for (const command of commands) {
      ctx.commands.register({ ...command, enabled: command.enabled ?? hasDoc });
      ctx.toolbar.addItem(MODE, { id: command.id, command: command.id });
    }

    const enter = () =>
      queueMicrotask(() => {
        if (useApp.getState().mode === MODE && !own(ctx.tools.active())) ctx.tools.activate(SELECT);
      });
    const leave = () => {
      usePlacing.setState({ placement: null });
      markActive(null);
      if (own(ctx.tools.active())) ctx.tools.activate(null);
      useAnnots.getState().set({ draft: null, editing: null });
    };
    disposers.push(
      useApp.subscribe((s, previous) => {
        if (s.mode === previous.mode) return;
        if (previous.mode === MODE) leave();
        if (s.mode === MODE) enter();
      }),
      installAnnotKeys({
        active: () => useApp.getState().mode === MODE,
        allow: (a) => !!a.fillSign,
        onEscape: () => {
          if (!usePlacing.getState().placement) return false;
          finish();
          return true;
        },
      }),
    );
    if (useApp.getState().mode === MODE) enter();
    return () => {
      leave();
      document.getElementById('garnet-fillsign-active-tool')?.remove();
      disposers.reverse().forEach((d) => d());
    };
  },
});
