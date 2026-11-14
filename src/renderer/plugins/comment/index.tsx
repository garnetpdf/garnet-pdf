/**
 * Comment mode: highlight, underline, strike-through and squiggly over text; sticky notes with
 * replies; text boxes and callouts; rectangles, ellipses, lines, arrows, polylines, polygons and
 * clouds; freehand ink; stamps. Every change is one engine operation, so undo works per gesture and
 * everything is saved as standard PDF annotations.
 */
import type { ComponentType } from 'react';
import {
  Circle,
  Cloud,
  Highlighter,
  Layers,
  MessageSquareQuote,
  MessagesSquare,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Pentagon,
  Spline,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Waves,
} from 'lucide-react';
import { definePlugin, type EditPage } from '../../plugin-host/types';
import { useApp } from '../../store';
import { connectAnnotStore, flattenAnnotations, useAnnots } from './shared/store';
import { mountDialogRoot, openDialog } from './shared/ui-root';
import { installAnnotKeys } from './shared/keys';
import {
  CalloutOverlay,
  ClickDraftOverlay,
  InkOverlay,
  MarkupOverlay,
  PolyOverlay,
  SelectOverlay,
  ShapeOverlay,
  StampOverlay,
  setToolApi,
} from './tools';
import { AnnotationInspector, CommentsPanel, ToolOptions, confirmFlatten, setConfirm } from './panels';
import { StampPicker } from './stamps';
import { useTools, type CommentTool } from './toolstate';
import './comment.css';

type Overlay = ComponentType<{ page: EditPage }>;
const HighlightTool: Overlay = ({ page }) => <MarkupOverlay page={page} tool="highlight" />;
const UnderlineTool: Overlay = ({ page }) => <MarkupOverlay page={page} tool="underline" />;
const StrikeTool: Overlay = ({ page }) => <MarkupOverlay page={page} tool="strike" />;
const SquigglyTool: Overlay = ({ page }) => <MarkupOverlay page={page} tool="squiggly" />;
const NoteTool: Overlay = ({ page }) => <ClickDraftOverlay page={page} tool="note" />;
const TextTool: Overlay = ({ page }) => <ClickDraftOverlay page={page} tool="textbox" />;
const RectTool: Overlay = ({ page }) => <ShapeOverlay page={page} tool="rect" />;
const EllipseTool: Overlay = ({ page }) => <ShapeOverlay page={page} tool="ellipse" />;
const LineTool: Overlay = ({ page }) => <ShapeOverlay page={page} tool="line" />;
const ArrowTool: Overlay = ({ page }) => <ShapeOverlay page={page} tool="arrow" />;
const PolylineTool: Overlay = ({ page }) => <PolyOverlay page={page} tool="polyline" />;
const PolygonTool: Overlay = ({ page }) => <PolyOverlay page={page} tool="polygon" />;
const CloudTool: Overlay = ({ page }) => <PolyOverlay page={page} tool="cloud" />;

interface ToolDef {
  tool: CommentTool;
  title: string;
  icon: ComponentType<{ size?: number }>;
  cursor: string;
  overlay: Overlay;
}
export const COMMENT_TOOLS: ToolDef[] = [
  { tool: 'select', title: 'Select', icon: MousePointer2, cursor: 'default', overlay: SelectOverlay },
  { tool: 'highlight', title: 'Highlight text', icon: Highlighter, cursor: 'text', overlay: HighlightTool },
  { tool: 'underline', title: 'Underline text', icon: Underline, cursor: 'text', overlay: UnderlineTool },
  { tool: 'strike', title: 'Strike through text', icon: Strikethrough, cursor: 'text', overlay: StrikeTool },
  { tool: 'squiggly', title: 'Squiggly underline', icon: Waves, cursor: 'text', overlay: SquigglyTool },
  { tool: 'note', title: 'Sticky note', icon: StickyNote, cursor: 'crosshair', overlay: NoteTool },
  { tool: 'textbox', title: 'Add text', icon: Type, cursor: 'text', overlay: TextTool },
  { tool: 'callout', title: 'Callout', icon: MessageSquareQuote, cursor: 'crosshair', overlay: CalloutOverlay },
  { tool: 'rect', title: 'Rectangle', icon: Square, cursor: 'crosshair', overlay: RectTool },
  { tool: 'ellipse', title: 'Ellipse', icon: Circle, cursor: 'crosshair', overlay: EllipseTool },
  { tool: 'line', title: 'Line', icon: Minus, cursor: 'crosshair', overlay: LineTool },
  { tool: 'arrow', title: 'Arrow', icon: MoveUpRight, cursor: 'crosshair', overlay: ArrowTool },
  { tool: 'polyline', title: 'Polyline', icon: Spline, cursor: 'crosshair', overlay: PolylineTool },
  { tool: 'polygon', title: 'Polygon', icon: Pentagon, cursor: 'crosshair', overlay: PolygonTool },
  { tool: 'cloud', title: 'Cloud', icon: Cloud, cursor: 'crosshair', overlay: CloudTool },
  { tool: 'ink', title: 'Draw', icon: PenLine, cursor: 'crosshair', overlay: InkOverlay },
  { tool: 'stamp', title: 'Stamp', icon: Stamp, cursor: 'copy', overlay: StampOverlay },
];

const MODE = 'Comment';
const titleOf = (tool: CommentTool) => COMMENT_TOOLS.find((t) => t.tool === tool)?.title ?? '';

/** Marks the active tool button (the shell toolbar has no pressed state for plugin buttons). */
function markActive(tool: CommentTool | null) {
  const id = 'garnet-comment-active-tool';
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  const title = tool ? titleOf(tool).replace(/"/g, '') : '';
  style.textContent = title
    ? `.context-toolbar [aria-label='Comment tools'] button[title="${title}"]{background:var(--accent-soft);color:var(--accent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 45%,transparent)}`
    : '';
  if (tool) document.documentElement.dataset.commentTool = tool;
  else delete document.documentElement.dataset.commentTool;
  requestAnimationFrame(() => {
    document
      .querySelectorAll<HTMLButtonElement>(".context-toolbar [aria-label='Comment tools'] button")
      .forEach((button) => {
        const own = COMMENT_TOOLS.some((t) => t.title === button.title);
        if (own) button.setAttribute('aria-pressed', String(!!title && button.title === title));
      });
  });
}

export default definePlugin({
  id: 'comment',
  name: 'Comment',
  version: '1.0.0',
  activate(ctx) {
    const disposers: (() => void)[] = [];
    disposers.push(connectAnnotStore(ctx, 'comment'), mountDialogRoot());
    setConfirm((message) => ctx.ui.confirm(message));
    const ownTool = (id: string | null) => !!id && id.startsWith('comment.');

    const activateTool = (tool: CommentTool) => {
      const app = useApp.getState();
      if (app.mode !== MODE) app.set({ mode: MODE });
      if (useApp.getState().hand) useApp.getState().set({ hand: false });
      useTools.getState().set({ tool });
      useAnnots.getState().set({ textSelection: null, ...(tool === 'select' ? {} : { selected: null, popup: null, editing: null }) });
      ctx.tools.activate(`comment.${tool}`);
      markActive(tool);
    };
    setToolApi({ activate: activateTool });

    for (const def of COMMENT_TOOLS) {
      ctx.tools.register({ id: `comment.${def.tool}`, cursor: def.cursor, overlay: def.overlay });
      ctx.commands.register({
        id: `comment.tool.${def.tool}`,
        title: def.title,
        icon: def.icon,
        enabled: () => !!ctx.documents.active(),
        run: () => {
          if (def.tool !== 'stamp') {
            activateTool(def.tool);
            return;
          }
          void openDialog('Choose a stamp', (close) => (
            <StampPicker
              close={close}
              onPick={(stamp) => {
                useTools.getState().set({ stamp });
                activateTool('stamp');
              }}
            />
          ));
        },
      });
      ctx.toolbar.addItem(MODE, { id: `comment.tool.${def.tool}`, command: `comment.tool.${def.tool}` });
    }
    ctx.commands.register({
      id: 'comment.list',
      title: 'Comments list',
      icon: MessagesSquare,
      enabled: () => !!ctx.documents.active(),
      run: () => {
        const app = useApp.getState();
        app.set({ sidebar: app.sidebar === 'Comments' ? '' : 'Comments' });
      },
    });
    ctx.toolbar.addItem(MODE, { id: 'comment.list', command: 'comment.list' });
    ctx.commands.register({
      id: 'comment.flatten',
      title: 'Flatten all comments',
      icon: Layers,
      enabled: () => !!ctx.documents.active(),
      run: async () => {
        const count = useAnnots.getState().items.filter((a) => a.irt === undefined && !a.fillSign).length;
        if (!count) {
          ctx.ui.toast('There are no comments to flatten.');
          return;
        }
        if (await confirmFlatten(count === 1 ? 'the comment' : `all ${count} comments`)) {
          const baked = await flattenAnnotations('comments');
          if (baked) ctx.ui.toast(`${baked} ${baked === 1 ? 'comment' : 'comments'} flattened into the page.`);
        }
      },
    });
    ctx.toolbar.addItem(MODE, { id: 'comment.flatten', command: 'comment.flatten' });

    ctx.panels.register('left', {
      id: 'Comments',
      title: 'Comments',
      component: CommentsPanel,
      icon: MessagesSquare,
    });
    ctx.panels.register('right', { id: 'comment-tool-options', title: 'Tool options', component: ToolOptions });
    ctx.inspector.register('annotation', AnnotationInspector);

    // Mode changes: Comment mode starts with the Select tool and shows the comment list.
    let sidebarBefore: string | null = null;
    const enter = () => {
      queueMicrotask(() => {
        if (useApp.getState().mode !== MODE) return;
        if (!ownTool(ctx.tools.active())) activateTool('select');
        else markActive(useTools.getState().tool);
      });
      const app = useApp.getState();
      if (app.tabs.length && (app.sidebar === 'Thumbnails' || app.sidebar === '')) {
        sidebarBefore = app.sidebar;
        app.set({ sidebar: 'Comments' });
      }
    };
    const leave = () => {
      if (ownTool(ctx.tools.active())) ctx.tools.activate(null);
      markActive(null);
      useAnnots.getState().set({ draft: null, textSelection: null, editing: null, popup: null });
      const app = useApp.getState();
      if (sidebarBefore !== null && app.sidebar === 'Comments') app.set({ sidebar: sidebarBefore });
      sidebarBefore = null;
    };
    disposers.push(
      useApp.subscribe((s, previous) => {
        if (s.mode === previous.mode) return;
        if (previous.mode === MODE) leave();
        if (s.mode === MODE) enter();
      }),
    );
    if (useApp.getState().mode === MODE) enter();

    disposers.push(
      installAnnotKeys({
        active: () => useApp.getState().mode === MODE,
        allow: (a) => !a.fillSign,
        onEscape: () => {
          if (useTools.getState().tool === 'select') return false;
          activateTool('select');
          return true;
        },
      }),
    );
    return () => {
      leave();
      setToolApi({ activate: () => {} });
      disposers.reverse().forEach((d) => d());
      document.getElementById('garnet-comment-active-tool')?.remove();
    };
  },
});
