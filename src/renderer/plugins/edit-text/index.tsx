import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { Bold, GripHorizontal, Italic, Plus } from 'lucide-react';
import { Button, ColorPicker, NumberInput, Panel, SegmentedControl, Toolbar } from '../../ui';
import {
  definePlugin,
  type EditPage,
  type Point,
  type Rect,
  type SelectionItem,
} from '../../plugin-host/types';
import { contains, inverse, transformPoint, transformRect } from '../../plugin-host/geometry';
import type { ParagraphsResult, StyledText, TextStyle } from '../../../engine/text/types';
import type { Paragraph } from '../../../engine/text/paragraphs';
import { hasSimulatedItalic } from '../../../engine/text/style';
import type { FontEntry } from '../../../shared/ipc';
import './text.css';

const PROVIDER = 'edit-text.paragraphs';
type Session = {
  docId: string;
  pageId: number;
  paragraph?: Paragraph;
  box?: { bbox: Rect; autoWidth: boolean };
  width?: number;
  offset?: Point;
  revision: number;
  point?: Point;
  preview?: string;
  faces: Record<string, string>;
  text: string;
  style: TextStyle;
  alignment: 'left' | 'right' | 'centre' | 'justified';
  leading: number;
  dirty: boolean;
  editing: boolean;
  notice?: string;
};
const key = (page: EditPage) => `${page.docId}:${page.pageId}`;
const rgbToHex = (c: readonly number[]) =>
  `#${c
    .map((x) =>
      Math.round(Math.min(1, Math.max(0, x)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const hexToRgb = (s: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number];
const boxInHost = (page: EditPage, p: Paragraph): Rect =>
  transformRect(inverse(page.pageToView), p.bbox);
const colorOf = (style: TextStyle) => rgbToHex(style.color);
const familyOf = (name: string) => {
  const bare = name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/,/g, '-')
    .replace(
      /[- ]?(?:bolditalic|boldoblique|semibold|demibold|bold|regular|roman|italic|oblique|black|medium)(?:MT)?$/i,
      '',
    )
    .replace(/(?:PS)?MT$/i, '')
    .replace(/PS$/i, '');
  return bare.replace(/^TimesNewRoman$/i, 'Times New Roman').replace(/^Arial$/i, 'Arial');
};

/**
 * Keeps each original line on one line in the editor. The browser never draws text exactly as wide as the
 * page did (no kerning from a subset font, a substitute font, different rounding), and a line only a pixel too
 * wide would drop its last word, add a line and push the paragraph over the text below. A line that is a
 * little too wide is tightened between its words (or letters, when it has no spaces); a line that is far too
 * wide is left to wrap. Applies only to the page's own lines: typed text wraps as usual.
 */
function fitOriginalLines(editor: HTMLElement) {
  const available = editor.clientWidth;
  if (!available) return;
  for (const line of Array.from(editor.children) as HTMLElement[]) {
    line.style.wordSpacing = '';
    line.style.letterSpacing = '';
    const text = line.textContent || '';
    if (!text.trim()) continue;
    const wrapping = line.style.whiteSpace;
    line.style.whiteSpace = 'nowrap';
    const range = document.createRange();
    range.selectNodeContents(line);
    const natural = range.getBoundingClientRect().width;
    line.style.whiteSpace = wrapping;
    const excess = natural - available + 1;
    if (excess <= 0 || excess > available * 0.08) continue;
    const spaces = (text.match(/ /g) || []).length;
    if (spaces) line.style.wordSpacing = `${-excess / spaces}px`;
    else if (!/[\u0590-\u08ff\ufb1d-\ufefc]/.test(text))
      line.style.letterSpacing = `${-excess / Math.max(1, [...text].length - 1)}px`;
  }
}
export default definePlugin({
  id: 'edit-text',
  name: 'Edit text',
  version: '1.0.0',
  activate(ctx) {
    const cache = new Map<string, ParagraphsResult>();
    const cacheGeneration = new Map<string, number>();
    const registeredHandles = new Map<string, Set<string>>();
    const sessions = new Map<string, Session>();
    const listeners = new Set<() => void>();
    let version = 0;
    let savedRange: Range | null = null;
    let lastHit: { key: string; point: Point } | undefined;
    const notify = () => {
      version++;
      listeners.forEach((fn) => fn());
    };
    const subscribe = (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    };
    const snapshot = () => version;
    const getParagraphs = async (page: EditPage, fresh = false) => {
      const id = key(page);
      const found = cache.get(id);
      if (found && !fresh) return found;
      const generation = cacheGeneration.get(page.docId) || 0;
      const got = await ctx.engine.call('text.paragraphs', {
        docId: page.docId,
        pageId: page.pageId,
      });
      if (generation !== (cacheGeneration.get(page.docId) || 0))
        return ctx.engine.call('text.paragraphs', { docId: page.docId, pageId: page.pageId });
      cache.set(id, got);
      return got;
    };
    const warm = (docId: string, pageId: number) => {
      const generation = cacheGeneration.get(docId) || 0;
      void ctx.engine
        .call('text.paragraphs', { docId, pageId })
        .then((got) => {
          if (generation === (cacheGeneration.get(docId) || 0)) {
            cache.set(`${docId}:${pageId}`, got);
            notify();
          }
        })
        .catch(() => {});
    };
    const clearCache = (docId: string) => {
      cacheGeneration.set(docId, (cacheGeneration.get(docId) || 0) + 1);
      for (const k of cache.keys()) if (k.startsWith(`${docId}:`)) cache.delete(k);
      const active = ctx.documents.active();
      if (active?.docId === docId) warm(docId, active.pageId);
      notify();
    };
    const close = (id: string) => {
      const s = sessions.get(id);
      if (s?.preview) URL.revokeObjectURL(s.preview);
      sessions.delete(id);
      savedRange = null;
      notify();
    };
    let fontList: Promise<FontEntry[]> | undefined;
    const fontEntries = () =>
      (fontList ??= window.garnet.fonts.list().catch((error) => {
        fontList = undefined;
        throw error;
      }));
    const registerNeeded = async (docId: string, text: string, styles: TextStyle[]) => {
      const entries = await fontEntries();
      const requests = styles.map((style) => ({
        family: familyOf(style.family || 'Liberation Sans'),
        bold: style.bold,
        italic: style.italic,
      }));
      const unique = (names: string[]) => [...new Set(names)];
      const families = unique(requests.map((r) => r.family));
      if (/[\u0600-\u06ff]/u.test(text))
        families.push(...unique(['Noto Naskh Arabic', 'Noto Sans Arabic']));
      const cjk = entries.filter((e) =>
        /Noto (?:Sans|Serif) CJK|Yu Gothic|Meiryo|YaHei|SimSun|(?:MS|Kozuka|Hiragino) (?:P?Gothic|P?Mincho)|Malgun Gothic|WenQuanYi|Droid Sans Fallback/i.test(
          e.family,
        ),
      );
      const cjkMatches = (pattern: RegExp) =>
        unique(cjk.filter((e) => pattern.test(e.family)).map((e) => e.family)).slice(0, 2);
      if (/[\u3040-\u30ff]/u.test(text))
        families.push(
          ...cjkMatches(/CJK JP|Yu Gothic|Meiryo|(?:MS|Kozuka|Hiragino) (?:P?Gothic|P?Mincho)/i),
        );
      if (/[\uac00-\ud7af]/u.test(text)) families.push(...cjkMatches(/CJK KR|Malgun Gothic/i));
      if (/[\u3400-\u9fff]/u.test(text))
        families.push(...cjkMatches(/CJK (?:SC|TC)|YaHei|SimSun|WenQuanYi|Droid Sans Fallback/i));
      families.push('Carlito', 'Caladea', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono');
      const variants = [
        ...new Set(requests.map((r) => `${Number(r.bold)}:${Number(r.italic)}`)),
      ].map((k) => ({ bold: k[0] === '1', italic: k[2] === '1' }));
      const selected: FontEntry[] = [];
      for (const family of unique(families)) {
        const same = entries.filter((e) => e.family.toLowerCase() === family.toLowerCase());
        for (const variant of variants) {
          const exact = same.find(
            (e) =>
              Boolean(/bold|black|semibold|demi/i.test(e.style)) === variant.bold &&
              Boolean(/italic|oblique/i.test(e.style)) === variant.italic,
          );
          const chosen = exact || same.find((e) => /regular|normal|book/i.test(e.style)) || same[0];
          if (chosen && !selected.some((e) => e.handle === chosen.handle)) selected.push(chosen);
        }
      }
      const known = registeredHandles.get(docId) || new Set<string>();
      const pending = selected.filter((e) => !known.has(e.handle)).slice(0, 24);
      if (!pending.length) return;
      const fonts = await Promise.all(
        pending.map(async (e) => ({
          family: e.family,
          style: e.style,
          bytes: await window.garnet.fonts.read(e.handle),
        })),
      );
      await ctx.engine.call('text.registerFonts', { docId, fonts });
      pending.forEach((e) => known.add(e.handle));
      registeredHandles.set(docId, known);
    };
    const registerMatch = async (p: Paragraph, page: EditPage) => {
      const info = (await getParagraphs(page)).fonts.find((f) => f.key === p.dominantStyle.fontKey);
      const family = p.dominantStyle.family || familyOf(info?.baseName || 'Carlito');
      await registerNeeded(page.docId, p.text, [{ ...p.dominantStyle, family }]);
    };
    const open = async (page: EditPage, p: Paragraph, pt?: Point) => {
      if (p.readOnly) {
        ctx.ui.toast(p.reason || 'This text is read-only.');
        return;
      }
      const id = key(page);
      if (sessions.get(id)?.paragraph?.id === p.id) return;
      await commit(id);
      try {
        await registerMatch(p, page);
        const preview = await ctx.engine.call('text.preview', {
          docId: page.docId,
          pageId: page.pageId,
          paragraphId: p.id,
          scale: 1,
        });
        const image = URL.createObjectURL(new Blob([preview.png], { type: 'image/png' }));
        const faces: Record<string, string> = {};
        for (const face of preview.faces) {
          const family = `Garnet-PDF-${face.fontKey.replace(/[^a-zA-Z0-9]/g, '-')}`;
          try {
            const ff = new FontFace(family, face.bytes, {
              weight: face.bold ? '700' : '400',
              style: face.italic ? 'italic' : 'normal',
            });
            await ff.load();
            document.fonts.add(ff);
            faces[face.fontKey] = family;
          } catch {
            ctx.ui.toast(
              'The PDF font cannot be displayed here. The editor is using a browser fallback font.',
            );
          }
        }
        const base = p.dominantStyle;
        const style: TextStyle = {
          fontKey: base.fontKey,
          family: base.family,
          size: base.size,
          color: base.color,
          bold: base.bold,
          italic: base.italic,
          charSpacing: base.charSpacing,
        };
        sessions.set(id, {
          docId: page.docId,
          pageId: page.pageId,
          paragraph: p,
          revision: (await getParagraphs(page)).revision,
          point: pt,
          preview: image,
          faces,
          text: p.text,
          style,
          alignment: p.alignment,
          leading: p.leading,
          dirty: false,
          editing: true,
          notice: p.invisible
            ? 'This changes searchable text only. The scan stays unchanged.'
            : undefined,
        });
        notify();
        if (preview.notices.length) ctx.ui.toast(preview.notices.join(' '));
        if (p.invisible)
          ctx.ui.toast('This changes searchable text only. The scan stays unchanged.');
      } catch (e) {
        ctx.ui.toast(`Cannot open text editor: ${String(e)}`);
      }
    };
    const create = (page: EditPage, box: { bbox: Rect; autoWidth: boolean }) => {
      const id = key(page);
      void commit(id).then(async () => {
        const data = await getParagraphs(page);
        const style: TextStyle = {
          size: 12,
          color: [0, 0, 0],
          bold: false,
          italic: false,
          charSpacing: 0,
          family: 'Liberation Sans',
        };
        sessions.set(id, {
          docId: page.docId,
          pageId: page.pageId,
          box,
          revision: data.revision,
          faces: {},
          text: '',
          style,
          alignment: 'left',
          leading: 14.4,
          dirty: true,
          editing: true,
        });
        notify();
      });
    };
    const commit = async (id: string, forced = false) => {
      const session = sessions.get(id);
      if (!session) return;
      if (!session.dirty && !session.box && !forced) {
        close(id);
        return;
      }
      if (!session.text.trim()) {
        if (session.paragraph && session.dirty) {
          try {
            await ctx.engine.call('text.delete', {
              docId: session.docId,
              pageId: session.pageId,
              paragraphIds: [session.paragraph.id],
            });
            close(id);
            clearCache(session.docId);
          } catch (e) {
            ctx.ui.toast(`Text was not changed: ${String(e)}`);
          }
        } else close(id);
        return;
      }
      session.editing = false;
      notify();
      try {
        const original = session.paragraph;
        const styleChanged =
          !original ||
          session.style.fontKey !== original.dominantStyle.fontKey ||
          session.style.family !== original.dominantStyle.family ||
          session.style.size !== original.dominantStyle.size ||
          session.style.bold !== original.dominantStyle.bold ||
          session.style.italic !== original.dominantStyle.italic ||
          session.style.charSpacing !== original.dominantStyle.charSpacing ||
          session.style.color.some((c, i) => Math.abs(c - original.dominantStyle.color[i]) > 1e-5);
        const request = {
          docId: session.docId,
          pageId: session.pageId,
          paragraphId: session.paragraph?.id,
          expectedRevision: session.revision,
          spans: collectSpans(id, session.text),
          style: styleChanged ? session.style : undefined,
          width:
            session.width ??
            (session.box && !session.box.autoWidth
              ? session.box.bbox[2] - session.box.bbox[0]
              : undefined),
          alignment:
            !original || session.alignment !== original.alignment ? session.alignment : undefined,
          leading: !original || session.leading !== original.leading ? session.leading : undefined,
          box: session.box,
        };
        await registerNeeded(session.docId, session.text, [
          session.style,
          ...request.spans.map((span) => ({ ...session.style, ...span.style })),
        ]);
        const result = await ctx.engine.call('text.commit', request);
        close(id);
        clearCache(session.docId);
        if (result.notices.length) ctx.ui.toast(result.notices.join(' '));
        if (result.overlap) ctx.ui.toast('Text may overlap content below it.');
        if (result.paragraphId) ctx.selection.set([]);
      } catch (e) {
        session.editing = true;
        notify();
        ctx.ui.toast(`Text was not changed: ${String(e)}`);
      }
    };
    const setSession = (id: string, patch: Partial<Session>) => {
      const s = sessions.get(id);
      if (s) {
        Object.assign(s, patch);
        notify();
      }
    };
    const candidates = async (page: EditPage, fresh = false): Promise<SelectionItem[]> =>
      (await getParagraphs(page, fresh)).paragraphs.map((p) => ({
        id: p.id,
        providerId: PROVIDER,
        kind: 'text',
        pageId: page.pageId,
        bounds: boxInHost(page, p),
        data: p,
      }));
    function EditorOverlay({ page }: { page: EditPage }) {
      useSyncExternalStore(subscribe, snapshot);
      const id = key(page),
        s = sessions.get(id),
        root = useRef<HTMLDivElement>(null),
        editor = useRef<HTMLDivElement>(null);
      const [scale, setScale] = useState(1);
      const display = transformRect(page.pageToView, [0, 0, page.width, page.height]);
      const displayWidth = display[2] - display[0],
        displayHeight = display[3] - display[1];
      useLayoutEffect(() => {
        const parent = root.current?.parentElement;
        if (!parent) return;
        const update = () => setScale(parent.clientWidth / displayWidth);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(parent);
        return () => ro.disconnect();
      }, [displayWidth, s?.editing]);
      useEffect(() => {
        if (!s?.editing || !editor.current) return;
        if (editor.current.dataset.session === `${s.paragraph?.id || 'new'}:${s.revision}`) {
          editor.current.querySelectorAll<HTMLElement>('span[data-size]').forEach((span) => {
            span.style.fontSize = `${Number(span.dataset.size) * scale}px`;
          });
          fitOriginalLines(editor.current);
          return;
        }
        editor.current.dataset.session = `${s.paragraph?.id || 'new'}:${s.revision}`;
        editor.current.replaceChildren();
        for (const line of s.paragraph?.lines || [{ text: '', runs: [] }]) {
          const div = document.createElement('div');
          const text = line.text || '';
          const runs = line.runs || [];
          const seen = new Set<string>();
          const parts = runs.map((run) => {
            if (run.actualTextSpan) {
              if (seen.has(run.actualTextSpan)) return '';
              seen.add(run.actualTextSpan);
            }
            return run.actualText ?? run.text;
          });
          if (runs.length > 1 && parts.join('') === text) {
            runs.forEach((run, i) => {
              if (!parts[i]) return;
              const span = document.createElement('span');
              span.textContent = parts[i];
              span.dataset.fontKey = run.fontKey;
              // sizes as drawn on the page (TextRun.userSize), not the raw operator numbers
              span.dataset.size = String(run.userSize);
              span.dataset.color = rgbToHex(run.fill || s.style.color);
              span.dataset.charSpacing = String(run.charSpacing * run.userScale[0]);
              const info = cache.get(id)?.fonts.find((f) => f.key === run.fontKey);
              span.dataset.family = familyOf(info?.baseName || s.style.family || 'Liberation Sans');
              span.style.fontFamily = s.faces[run.fontKey] || span.dataset.family;
              span.style.fontSize = `${run.userSize * scale}px`;
              span.style.color = span.dataset.color;
              span.style.fontWeight = info?.bold ? '700' : '400';
              span.style.fontStyle = info?.italic || hasSimulatedItalic(run) ? 'italic' : 'normal';
              div.append(span);
            });
          } else div.textContent = text || '\u200b';
          editor.current.append(div);
        }
        fitOriginalLines(editor.current);
        // an embedded font may finish loading a moment later and change the widths
        const fitted = editor.current;
        void document.fonts.ready.then(() => fitOriginalLines(fitted));
        editor.current.focus();
        if (s.point) {
          requestAnimationFrame(() => {
            const v = transformPoint(page.pageToView, s.point!);
            const r = root.current?.getBoundingClientRect();
            const range =
              r && document.caretRangeFromPoint(r.left + v[0] * scale, r.top + v[1] * scale);
            if (range && editor.current?.contains(range.startContainer)) {
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }
          });
        }
      }, [s?.paragraph?.id, s?.revision, s?.editing, page, s, scale]);
      useEffect(() => {
        if (!s?.editing) return;
        const saveSelection = () => {
          const selection = window.getSelection();
          if (
            selection &&
            !selection.isCollapsed &&
            selection.rangeCount &&
            editor.current?.contains(selection.getRangeAt(0).commonAncestorContainer)
          )
            savedRange = selection.getRangeAt(0).cloneRange();
        };
        document.addEventListener('selectionchange', saveSelection);
        const outside = (event: PointerEvent) => {
          const target = event.target as Node;
          if (root.current?.contains(target)) return;
          if (
            target instanceof Element &&
            target.closest('.text-inspector, [aria-label="Inspector"]')
          )
            return;
          if (composing) {
            pendingCommit = id;
            return;
          }
          void commit(id);
        };
        document.addEventListener('pointerdown', outside, true);
        return () => {
          document.removeEventListener('pointerdown', outside, true);
          document.removeEventListener('selectionchange', saveSelection);
        };
      }, [id, s?.editing]);
      if (!s) return null;
      const b = s.paragraph ? s.paragraph.layoutBBox : transformRect(page.viewToPage, s.box!.bbox);
      const m = s.paragraph?.layoutToPage ?? page.pageToView;
      const origin = m ? transformPoint(m, [b[0], b[1]]) : [b[0], b[1]];
      const baseStyle: CSSProperties = {
        left: (origin[0] + (s.offset?.[0] || 0)) * scale,
        top: (origin[1] + (s.offset?.[1] || 0)) * scale,
        width: Math.max(25, (s.width ?? b[2] - b[0]) * scale),
        minHeight: Math.max(18, (b[3] - b[1]) * scale),
        transform: m ? `matrix(${m[0]},${m[1]},${m[2]},${m[3]},0,0)` : undefined,
        transformOrigin: '0 0',
        fontFamily: s.faces[s.style.fontKey || ''] || s.style.family || 'Arial, sans-serif',
        fontSize: s.style.size * scale,
        color: colorOf(s.style),
        fontWeight: s.style.bold ? 700 : 400,
        fontStyle: s.style.italic ? 'italic' : 'normal',
        lineHeight: `${s.leading * scale}px`,
        letterSpacing: s.style.charSpacing * scale,
        textAlign:
          s.alignment === 'centre'
            ? 'center'
            : s.alignment === 'justified'
              ? 'justify'
              : s.alignment,
        direction: s.paragraph?.direction || 'ltr',
      };
      const editorStyle: CSSProperties = s.paragraph?.hangingIndent
        ? {
            paddingInlineStart: s.paragraph.hangingIndent * scale,
            textIndent: -s.paragraph.hangingIndent * scale,
            boxSizing: 'border-box',
          }
        : {};
      return (
        <div
          ref={root}
          className="text-edit-layer"
          data-testid="text-edit-layer"
          data-text-session={id}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {s.preview && s.paragraph && (
            <img
              alt=""
              data-testid="text-scratch-page"
              className="text-scratch-page"
              src={s.preview}
              style={{
                clipPath: `inset(${Math.max(0, s.paragraph.bbox[1] * scale - 2)}px ${Math.max(0, (displayWidth - s.paragraph.bbox[2]) * scale - 2)}px ${Math.max(0, (displayHeight - s.paragraph.bbox[3]) * scale - 2)}px ${Math.max(0, s.paragraph.bbox[0] * scale - 2)}px)`,
              }}
            />
          )}
          <div className="text-edit-frame" style={baseStyle}>
            <div
              ref={editor}
              className="text-editor"
              data-text-scale={scale}
              style={editorStyle}
              data-testid="text-editor"
              role="textbox"
              aria-label="Edit paragraph text"
              aria-multiline="true"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              dir={s.paragraph?.direction || 'ltr'}
              onPointerDown={(e) => e.stopPropagation()}
              onInput={(e) => {
                s.text = (e.currentTarget as HTMLDivElement).innerText.replace(/\u200b/g, '');
                s.dirty = true;
              }}
              onCompositionStart={() => {
                composing = true;
              }}
              onCompositionEnd={(e) => {
                composing = false;
                s.text = (e.currentTarget as HTMLDivElement).innerText.replace(/\u200b/g, '');
                s.dirty = true;
                if (pendingCommit === id) {
                  pendingCommit = undefined;
                  queueMicrotask(() => void commit(id));
                }
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape' && !composing) {
                  e.preventDefault();
                  close(id);
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !composing) {
                  e.preventDefault();
                  s.text = e.currentTarget.innerText.replace(/\u200b/g, '');
                  s.dirty = true;
                  void commit(id, true);
                }
              }}
            />
            {s.notice && (
              <div className="text-edit-notice" role="status">
                {s.notice}
              </div>
            )}
            <div className="text-edit-actions">
              <Button onClick={() => void commit(id, true)}>Apply</Button>
              <Button onClick={() => close(id)}>Cancel</Button>
            </div>
            <div
              className="text-move-grip"
              role="button"
              aria-label="Move paragraph"
              title="Drag to move text"
              onPointerDown={(e) => {
                e.stopPropagation();
                if (s.dirty && s.paragraph) {
                  ctx.ui.toast('Apply text changes before moving this paragraph.');
                  return;
                }
                moving = { id, startX: e.clientX, startY: e.clientY, scale };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (moving?.id === id) {
                  e.stopPropagation();
                  setSession(id, {
                    offset: [
                      (e.clientX - moving.startX) / moving.scale,
                      (e.clientY - moving.startY) / moving.scale,
                    ],
                  });
                }
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                if (moving?.id !== id) return;
                const offset = s.offset || [0, 0];
                moving = undefined;
                if (Math.hypot(...offset) < 2) {
                  setSession(id, { offset: undefined });
                  return;
                }
                if (s.box) {
                  const old = s.box.bbox;
                  setSession(id, {
                    box: {
                      ...s.box,
                      bbox: [
                        old[0] + offset[0],
                        old[1] + offset[1],
                        old[2] + offset[0],
                        old[3] + offset[1],
                      ],
                    },
                    offset: undefined,
                    dirty: true,
                  });
                  return;
                }
                const start = transformPoint(page.viewToPage, [0, 0]),
                  end = transformPoint(page.viewToPage, offset);
                void ctx.engine
                  .call('text.transform', {
                    docId: s.docId,
                    pageId: s.pageId,
                    paragraphIds: [s.paragraph!.id],
                    matrix: [1, 0, 0, 1, end[0] - start[0], end[1] - start[1]],
                  })
                  .then(() => {
                    close(id);
                    clearCache(s.docId);
                  })
                  .catch((error) => {
                    setSession(id, { offset: undefined });
                    ctx.ui.toast(`Text was not moved: ${String(error)}`);
                  });
              }}
            >
              <GripHorizontal size={14} />
            </div>
            <div
              className="text-width-grip"
              role="button"
              aria-label="Resize text width"
              onPointerDown={(e) => {
                e.stopPropagation();
                resizing = { id, start: e.clientX, width: s.width ?? b[2] - b[0], scale };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (resizing?.id === id) {
                  const width = Math.max(
                    20,
                    resizing.width + (e.clientX - resizing.start) / resizing.scale,
                  );
                  setSession(id, {
                    width,
                    dirty: true,
                    ...(s.box ? { box: { ...s.box, autoWidth: false } } : {}),
                  });
                }
              }}
              onPointerUp={(e) => {
                resizing = undefined;
                e.stopPropagation();
              }}
            />
          </div>
        </div>
      );
    }
    let composing = false;
    let pendingCommit: string | undefined;
    let resizing: { id: string; start: number; width: number; scale: number } | undefined;
    let moving: { id: string; startX: number; startY: number; scale: number } | undefined;
    let drawing: { page: EditPage; start: Point; current: Point } | undefined;
    const startBox = (page: EditPage, pt: Point) => {
      drawing = { page, start: pt, current: pt };
    };
    const moveBox = (page: EditPage, pt: Point) => {
      if (drawing && key(drawing.page) === key(page)) drawing.current = pt;
    };
    const endBox = (page: EditPage, pt: Point) => {
      if (!drawing || key(drawing.page) !== key(page)) return;
      const a = drawing.start,
        b = pt;
      drawing = undefined;
      const auto = Math.abs(a[0] - b[0]) < 5;
      const rect: Rect = [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        auto ? a[0] + 180 : Math.max(a[0] + 20, Math.max(a[0], b[0])),
        Math.max(a[1] + 20, Math.max(a[1], b[1])),
      ];
      const pageRect = transformRect(page.pageToView, rect);
      create(page, { bbox: pageRect, autoWidth: auto });
      ctx.tools.activate(null);
    };
    function Inspector({ selection }: { selection: SelectionItem[] }) {
      useSyncExternalStore(subscribe, snapshot);
      const item = selection[0];
      const p = item?.data as Paragraph | undefined;
      const id = ctx.documents.active() ? `${ctx.documents.active()!.docId}:${item.pageId}` : '';
      const s = sessions.get(id);
      const [system, setSystem] = useState<{ family: string; style: string; handle: string }[]>([]);
      useEffect(() => {
        void fontEntries().then(setSystem);
      }, []);
      if (!p) return null;
      const st: TextStyle = s?.style || p.dominantStyle;
      const selectionFlag = (field: 'bold' | 'italic', fallback: boolean) => {
        const current = window.getSelection();
        const range =
          current?.rangeCount && !current.isCollapsed ? current.getRangeAt(0) : savedRange;
        const node = range?.startContainer;
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element?.closest('[data-testid="text-editor"]')) return fallback;
        const computed = getComputedStyle(element);
        return field === 'bold'
          ? Number(computed.fontWeight) >= 600
          : computed.fontStyle === 'italic' || computed.fontStyle === 'oblique';
      };
      const setStyle = (patch: Partial<TextStyle>) => {
        if (s) {
          const selected = applySelectionStyle(patch, savedRange);
          if (selected) {
            setSession(id, { dirty: true });
            return;
          }
          const editor = document.querySelector<HTMLElement>('[data-testid="text-editor"]');
          const factor = editor ? parseFloat(getComputedStyle(editor).fontSize) / s.style.size : 1;
          editor?.querySelectorAll<HTMLElement>('span').forEach((span) => {
            if (patch.size !== undefined) {
              span.dataset.size = String(patch.size);
              span.style.fontSize = `${patch.size * factor}px`;
            }
            if (patch.color) {
              span.dataset.color = rgbToHex(patch.color);
              span.style.color = rgbToHex(patch.color);
            }
            if (patch.family) {
              span.dataset.family = patch.family;
              span.style.fontFamily = patch.family;
            }
            if (patch.bold !== undefined) span.style.fontWeight = patch.bold ? '700' : '400';
            if (patch.italic !== undefined)
              span.style.fontStyle = patch.italic ? 'italic' : 'normal';
          });
          setSession(id, { style: { ...s.style, ...patch }, dirty: true });
        }
      };
      const fonts = [
        ...new Set([
          ...(cache.get(id)?.fonts.map((f) => f.baseName) || []),
          ...system.map((f) => f.family),
          'Carlito',
          'Caladea',
          'Liberation Sans',
          'Liberation Serif',
          'Liberation Mono',
          'Noto Naskh Arabic',
        ]),
      ];
      const currentFamily =
        st.family || cache.get(id)?.fonts.find((f) => f.key === st.fontKey)?.baseName || fonts[0];
      const chooseFamily = async (family: string) => {
        if (!s) return;
        try {
          await registerNeeded(s.docId, s.text, [{ ...s.style, family }]);
        } catch (e) {
          ctx.ui.toast(`Cannot load ${family}: ${String(e)}`);
          return;
        }
        setStyle({ family });
      };
      return (
        <Panel title="Text">
          <div
            className="text-inspector"
            onPointerDownCapture={(e) => {
              if ((e.target as Element).closest('button')) e.preventDefault();
            }}
          >
            <label>
              Font
              <select
                aria-label="Font family"
                value={currentFamily}
                onChange={(e) => void chooseFamily(e.target.value)}
              >
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-field">
              <span>Size</span>
              <NumberInput
                aria-label="Font size"
                unit="pt"
                min={1}
                max={500}
                value={st.size}
                onChange={(e) => setStyle({ size: Number(e.target.value) })}
              />
            </div>
            <label>
              Colour
              <ColorPicker
                aria-label="Text colour"
                value={rgbToHex(st.color)}
                onChange={(e) => setStyle({ color: hexToRgb(e.target.value) })}
              />
            </label>
            <Toolbar label="Text style">
              <Button
                aria-label="Bold"
                aria-pressed={st.bold}
                onClick={() => setStyle({ bold: !selectionFlag('bold', st.bold) })}
              >
                <Bold size={14} />
              </Button>
              <Button
                aria-label="Italic"
                aria-pressed={st.italic}
                onClick={() => setStyle({ italic: !selectionFlag('italic', st.italic) })}
              >
                <Italic size={14} />
              </Button>
            </Toolbar>
            <div className="text-field">
              <span>Alignment</span>
              <SegmentedControl
                options={['left', 'centre', 'right', 'justified'] as const}
                value={s?.alignment || p.alignment}
                label="Text alignment"
                onChange={(v) => setSession(id, { alignment: v, dirty: true })}
              />
            </div>
            <div className="text-field">
              <span>Line spacing</span>
              <NumberInput
                aria-label="Line spacing"
                unit="pt"
                min={1}
                value={s?.leading || p.leading}
                onChange={(e) => setSession(id, { leading: Number(e.target.value), dirty: true })}
              />
            </div>
            <div className="text-field">
              <span>Character spacing</span>
              <NumberInput
                aria-label="Character spacing"
                unit="pt"
                step="0.1"
                value={st.charSpacing}
                onChange={(e) => setStyle({ charSpacing: Number(e.target.value) })}
              />
            </div>
          </div>
        </Panel>
      );
    }
    const provider = ctx.edit.registerProvider({
      id: PROVIDER,
      kinds: ['text'],
      hoverCandidates: candidates,
      hitTest: (page, pt) => {
        if (ctx.tools.active() === 'edit-text.add') return null;
        const pick = (items: SelectionItem[]) => {
          const exact = items.filter((x) => contains(x.bounds, pt)).at(-1);
          const hit =
            exact ||
            items
              .filter((x) => {
                const p = x.data as Paragraph;
                if (!p.boxTag) return false;
                const [x1, y1, x2, y2] = x.bounds;
                return contains([x1 - 2, y1 - 2, x2 + 2, y2 + 4], pt);
              })
              .at(-1) ||
            null;
          if (hit) lastHit = { key: key(page), point: pt };
          return hit;
        };
        const ready = cache.get(key(page));
        return ready
          ? pick(
              ready.paragraphs.map((p) => ({
                id: p.id,
                providerId: PROVIDER,
                kind: 'text',
                pageId: page.pageId,
                bounds: boxInHost(page, p),
                data: p,
              })),
            )
          : candidates(page).then(pick);
      },
      onActivate: (items, page) => {
        const p = items.at(-1)?.data as Paragraph | undefined;
        if (p) void open(page, p, lastHit?.key === key(page) ? lastHit.point : undefined);
      },
      onTransform: async (items, matrix, page) => {
        const pids = items.map((x) => x.id);
        await ctx.engine.call('text.transform', {
          docId: page.docId,
          pageId: page.pageId,
          paragraphIds: pids,
          matrix,
        });
        clearCache(page.docId);
      },
      onDelete: async (items, page) => {
        await ctx.engine.call('text.delete', {
          docId: page.docId,
          pageId: page.pageId,
          paragraphIds: items.map((x) => x.id),
        });
        clearCache(page.docId);
      },
      overlay: EditorOverlay,
    });
    ctx.inspector.register('text', Inspector);
    ctx.tools.register({
      id: 'edit-text.add',
      cursor: 'text',
      onPointerDown: startBox,
      onPointerMove: moveBox,
      onPointerUp: endBox,
    });
    ctx.commands.register({
      id: 'edit-text.add',
      title: 'Add text box',
      icon: Plus,
      run: () => {
        ctx.tools.activate('edit-text.add');
        ctx.ui.toast('Click for an automatic text box, or drag to set its width.');
      },
    });
    ctx.toolbar.addItem('Edit', {
      id: 'edit-text.add',
      command: 'edit-text.add',
      label: 'Add text',
    });
    const unsubOpened = ctx.documents.subscribe('opened', (d) => warm(d.docId, d.pageId));
    const unsubChanged = ctx.documents.subscribe('changed', (d) => clearCache(d.docId));
    const unsubClosed = ctx.documents.subscribe('closed', (d) => {
      clearCache(d.docId);
      registeredHandles.delete(d.docId);
      for (const k of [...sessions.keys()]) if (k.startsWith(`${d.docId}:`)) close(k);
    });
    return () => {
      provider();
      unsubOpened();
      unsubChanged();
      unsubClosed();
      for (const k of [...sessions.keys()]) close(k);
    };
  },
});

function collectSpans(id: string, fallback: string): StyledText[] {
  const node = [...document.querySelectorAll<HTMLDivElement>('[data-text-session]')]
    .find((el) => el.dataset.textSession === id)
    ?.querySelector<HTMLDivElement>('[data-testid="text-editor"]');
  if (!node) return [{ text: fallback }];
  const out: StyledText[] = [];
  const visit = (n: Node, style: Partial<TextStyle>) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent?.replace(/\u200b/g, '') || '';
      if (text) out.push({ text, style });
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    if (n.tagName === 'BR') {
      out.push({ text: '\n' });
      return;
    }
    const next = { ...style };
    if (n.style.fontWeight)
      next.bold = n.style.fontWeight === 'bold' || Number(n.style.fontWeight) >= 600;
    else if (n.tagName === 'B' || n.tagName === 'STRONG') next.bold = true;
    if (n.style.fontStyle) next.italic = /italic|oblique/i.test(n.style.fontStyle);
    else if (n.tagName === 'I' || n.tagName === 'EM') next.italic = true;
    if (n.dataset.color) next.color = hexToRgb(n.dataset.color);
    else if (n.style.color && n.style.color.startsWith('#')) next.color = hexToRgb(n.style.color);
    if (n.dataset.size) next.size = Number(n.dataset.size);
    else if (n.style.fontSize) next.size = parseFloat(n.style.fontSize);
    if (n.dataset.fontKey) next.fontKey = n.dataset.fontKey;
    if (n.dataset.charSpacing) next.charSpacing = Number(n.dataset.charSpacing);
    if (n.dataset.family) next.family = n.dataset.family;
    n.childNodes.forEach((c) => visit(c, next));
    if (n !== node && (n.tagName === 'DIV' || n.tagName === 'P') && n.nextSibling)
      out.push({ text: '\n' });
  };
  node.childNodes.forEach((c) => visit(c, {}));
  if (!out.length) return [{ text: fallback }];
  if (out.every((x) => !x.style || Object.keys(x.style).length === 0))
    return [{ text: out.map((x) => x.text).join('') }];
  return out;
}
function applySelectionStyle(patch: Partial<TextStyle>, fallbackRange: Range | null): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const current = selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const range = current || fallbackRange;
  const editor = document.querySelector('[data-testid="text-editor"]');
  if (!range || !editor?.contains(range.commonAncestorContainer)) return false;
  const span = document.createElement('span');
  if (patch.bold !== undefined) span.style.fontWeight = patch.bold ? '700' : '400';
  if (patch.italic !== undefined) span.style.fontStyle = patch.italic ? 'italic' : 'normal';
  if (patch.color) {
    span.dataset.color = rgbToHex(patch.color);
    span.style.color = span.dataset.color;
  }
  if (patch.size !== undefined) {
    span.dataset.size = String(patch.size);
    span.style.fontSize = `${patch.size * (Number((editor as HTMLElement).dataset.textScale) || 1)}px`;
  }
  if (patch.family) {
    span.dataset.family = patch.family;
    span.style.fontFamily = patch.family;
  }
  try {
    range.surroundContents(span);
  } catch {
    span.append(range.extractContents());
    range.insertNode(span);
  }
  selection.removeAllRanges();
  const next = document.createRange();
  next.selectNodeContents(span);
  selection.addRange(next);
  return true;
}
