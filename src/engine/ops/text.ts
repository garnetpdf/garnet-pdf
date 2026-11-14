import * as mupdf from 'mupdf';
import {
  getTextReflowState,
  deleteObjects,
  flattenObjects,
  insertText,
  interpretPage,
  invalidateFontCache,
  invert,
  concat,
  point,
  transformRect,
  transformObjects,
  replaceTextRun,
  ContentEditError,
  type InsertTextSpec,
  type Matrix,
  type PageModel,
  type Rect,
  type TextRun,
} from '@garnet/pdf-content';
import type { EngineContext } from '../context';
import { detectParagraphs, type Paragraph } from '../text/paragraphs';
import { registerSystemFonts, previewFont, normaliseFontName } from '../text/fonts';
import { defaultStyle, layoutParagraph, type ParagraphLayout } from '../text/layout';
import { planTier1, type RunReplacement } from '../text/tier1';
import type {
  TextCommitArgs,
  TextCommitResult,
  TextPreviewResult,
  ParagraphsResult,
  SystemFontInput,
} from '../text/types';
import type { PageId, OpResult } from '../../shared/engine-api';
import { simulatedItalicShear } from '../text/style';
import { logicalChunks } from '../text/clusters';

type PageArgs = { docId: string; pageId: PageId };
const runs = (model: PageModel) =>
  flattenObjects(model.objects).filter((r): r is TextRun => r.kind === 'text');
function pageModel(ctx: EngineContext, args: PageArgs) {
  const doc = ctx.get(args.docId),
    index = ctx.pageIndex(args.docId, args.pageId);
  invalidateFontCache(doc.pdf);
  return { doc, index, model: interpretPage(doc.pdf, index) };
}
function paragraphs(pdf: mupdf.PDFDocument, index: number, model: PageModel): Paragraph[] {
  const boxes = pdf.findPage(index).get('GarnetTextBoxes');
  return detectParagraphs(model).map((p) => {
    p.dominantStyle.family = normaliseFontName(
      model.fonts[p.dominantStyle.fontKey]?.baseName ?? 'Carlito',
    ).family;
    if (p.boxTag && !boxes.isNull()) {
      const stored = boxes.get(p.boxTag);
      if (stored.isString() && stored.asString().length < 1000000) {
        try {
          const meta = JSON.parse(stored.asString());
          if (
            typeof meta.text === 'string' &&
            meta.text.replace(/\s/g, '') === p.text.replace(/\s/g, '') &&
            Array.isArray(meta.bbox) &&
            meta.bbox.length === 4 &&
            meta.bbox.every(Number.isFinite) &&
            meta.bbox[2] > meta.bbox[0] &&
            meta.bbox[3] > meta.bbox[1] &&
            meta.bbox[2] - meta.bbox[0] <= 100000
          ) {
            const frame = transformRect(meta.bbox, p.layoutToPage!);
            p.layoutBBox = meta.bbox;
            p.bbox = [
              Math.min(frame[0], p.bbox[0]),
              Math.min(frame[1], p.bbox[1]),
              Math.max(frame[2], p.bbox[2]),
              Math.max(frame[3], p.bbox[3]),
            ];
            p.text = meta.text;
            p.autoWidth = meta.autoWidth === true;
            if (Number.isFinite(meta.leading) && meta.leading > 0) p.leading = meta.leading;
            if (
              Number.isFinite(meta.hangingIndent) &&
              meta.hangingIndent >= 0 &&
              meta.hangingIndent < meta.bbox[2] - meta.bbox[0]
            )
              p.hangingIndent = meta.hangingIndent;
            if (['left', 'right', 'centre', 'justified'].includes(meta.alignment))
              p.alignment = meta.alignment;
          }
        } catch {
          /* Untrusted or obsolete box metadata is ignored; painting stays authoritative. */
        }
      }
    }
    return p;
  });
}
function findParagraph(
  pdf: mupdf.PDFDocument,
  index: number,
  model: PageModel,
  id: string,
): Paragraph {
  const paragraph = paragraphs(pdf, index, model).find((p) => p.id === id);
  if (!paragraph) throw new Error('This paragraph changed. Select it again before editing.');
  return paragraph;
}
function idsFor(p: Paragraph) {
  return paragraphRuns(p).map((r) => r.id);
}
function paragraphRuns(p: Paragraph) {
  return p.lines.flatMap((l) => l.runs);
}
function fullScope(model: PageModel, p: Paragraph) {
  const ids = new Set(paragraphRuns(p).map((r) => r.id)),
    spans = new Set(
      paragraphRuns(p)
        .map((r) => r.actualTextSpan)
        .filter(Boolean),
    );
  if (runs(model).some((r) => r.actualTextSpan && spans.has(r.actualTextSpan) && !ids.has(r.id)))
    throw new Error(
      'This text shares a replacement span with another block. Edit the complete span.',
    );
}
function scratchPage(pdf: mupdf.PDFDocument, index: number) {
  const scratch = new mupdf.PDFDocument();
  scratch.graftPage(0, pdf, index);
  return scratch;
}
function mapRuns(source: PageModel, target: PageModel, ids: string[]) {
  const before = runs(source),
    after = runs(target);
  return ids.map((id) => {
    const i = before.findIndex((r) => r.id === id);
    if (i < 0 || !after[i] || before[i].text !== after[i].text)
      throw new Error('Scratch-page object mapping failed.');
    return after[i].id;
  });
}
function replaceAll(pdf: mupdf.PDFDocument, index: number, replacements: RunReplacement[]): void {
  const pending = replacements.map((r) => ({ ...r }));
  for (let i = 0; i < pending.length; i++) {
    const result = replaceTextRun(pdf, index, pending[i].id, pending[i].text, {
      allowInvisible: true,
    });
    if (!result.ok)
      throw new ContentEditError(`Original-font replacement requires reflow: ${result.reason}`);
    for (let j = i + 1; j < pending.length; j++)
      pending[j].id = result.newIds[pending[j].id]?.[0] ?? pending[j].id;
  }
}
function userFromLayout(model: PageModel): Matrix {
  // Unrotated top-left layout coordinates -> default PDF user space.
  return [1, 0, 0, -1, model.cropBox[0], model.cropBox[3]];
}
function paragraphBounds(p: Paragraph): Rect {
  return p.layoutBBox ?? p.bbox;
}
function adjustedParagraph(p: Paragraph): Paragraph {
  return {
    ...p,
    bbox: paragraphBounds(p),
    lines: p.lines.map((l) => ({ ...l, baseline: l.layoutBaseline ?? l.baseline })),
  };
}
function appendLayout(
  pdf: mupdf.PDFDocument,
  index: number,
  model: PageModel,
  layout: ParagraphLayout,
  tag: string,
  mode: number,
  clip: string,
) {
  const toUser = userFromLayout(model);
  const specs: InsertTextSpec[] = [];
  for (const line of layout.lines)
    for (const run of line.runs)
      for (const chunk of logicalChunks(run)) {
        if (!run.text) continue;
        const origin = point([run.x + chunk.offset, line.baseline], toUser);
        specs.push({
          font: {
            program: run.font.program,
            name:
              run.font.family +
              (run.style.bold ? '-Bold' : '') +
              (run.style.italic ? '-Italic' : ''),
          },
          size: run.style.size,
          color: run.style.color,
          origin,
          matrix:
            run.style.italic && !run.font.italic
              ? [1, 0, simulatedItalicShear, 1, 0, 0]
              : undefined,
          text: chunk.text,
          glyphs: chunk.glyphs,
          actualText: chunk.text,
          direction: run.direction,
          markTag: tag,
          renderMode: mode === 3 ? 3 : 0,
          clip,
        });
      }
  if (specs.length) insertText(pdf, index, specs);
}
function overlapWarning(
  model: PageModel,
  p: Paragraph | undefined,
  layout: ParagraphLayout,
  args: TextCommitArgs,
): boolean {
  const originalIds = new Set(p ? paragraphRuns(p).map((r) => r.id) : []);
  const box = p ? paragraphBounds(p) : args.box!.bbox;
  const bottom =
    (layout.lines.at(-1)?.baseline ?? box[1]) +
    (args.style?.size ?? p?.dominantStyle.size ?? 12) * 0.25;
  const rect: Rect = [box[0], box[1], box[0] + layout.width, bottom];
  const toLayout = invert(userFromLayout(model));
  return (
    layout.overflow ||
    flattenObjects(model.objects).some((o) => {
      if (originalIds.has(o.id) || o.kind === 'form') return false;
      // Treat only following objects as overlap risks; an existing background scan is intentional.
      const corners = [
        point([o.bbox[0], o.bbox[1]], toLayout),
        point([o.bbox[2], o.bbox[3]], toLayout),
      ];
      const b = [
        Math.min(corners[0][0], corners[1][0]),
        Math.min(corners[0][1], corners[1][1]),
        Math.max(corners[0][0], corners[1][0]),
        Math.max(corners[0][1], corners[1][1]),
      ];
      return (
        b[1] >= box[3] - 0.1 && rect[2] > b[0] && rect[0] < b[2] && rect[3] > b[1] && rect[1] < b[3]
      );
    })
  );
}
function validateTier2(model: PageModel, p: Paragraph) {
  fullScope(model, p);
  for (const r of paragraphRuns(p)) {
    if (
      !r.editability.delete &&
      model.fonts[r.fontKey]?.subtype !== 'Type3' &&
      !(p.boxTag && r.actualTextSpan)
    )
      throw new Error(r.editability.reason ?? 'This paragraph cannot safely be replaced.');
    if (r.renderMode !== 0 && r.renderMode !== 3)
      throw new Error(
        'This paragraph uses stroked or clipping text. Its rendering is preserved; reflow is unavailable.',
      );
    if ((r.opacity?.fill ?? 1) !== 1 || (r.opacity?.stroke ?? 1) !== 1)
      throw new Error(
        'Reflow of transparent text is unavailable. Its original appearance has been preserved.',
      );
  }
}
function removeParagraph(pdf: mupdf.PDFDocument, index: number, ids: string[]) {
  deleteObjects(pdf, index, ids, { allowType3Text: true, allowShapedText: true });
}
async function commit(ctx: EngineContext, args: TextCommitArgs): Promise<TextCommitResult> {
  const start = performance.now(),
    { doc, index, model } = pageModel(ctx, args);
  if (doc.revision !== args.expectedRevision)
    throw new Error(
      'The document changed while this paragraph was open. Cancel and reopen the editor.',
    );
  if (!args.paragraphId && !args.box) throw new Error('A paragraph or new text box is required.');
  const p = args.paragraphId ? findParagraph(doc.pdf, index, model, args.paragraphId) : undefined;
  if (args.box) {
    const pageToLayout = invert(concat(userFromLayout(model), model.userToPage));
    const bbox = transformRect(args.box.bbox, pageToLayout);
    args = {
      ...args,
      width: args.box.autoWidth ? undefined : bbox[2] - bbox[0],
      box: {
        ...args.box,
        bbox,
        baseline: args.box.baseline ? point(args.box.baseline, pageToLayout) : undefined,
      },
    };
  }
  if (p?.readOnly) throw new Error(p.reason ?? 'This text is read-only.');
  const plain = args.spans.map((s) => s.text).join('');
  const notices: string[] = [];
  if (p?.invisible)
    notices.push('Only the searchable text layer changed. The visible scan is unchanged.');
  let tier1 = p ? await planTier1(doc.pdf, model, p, args) : null;
  if (tier1 && tier1.length) {
    const scratch = scratchPage(doc.pdf, index);
    try {
      const mapped = mapRuns(
        model,
        interpretPage(scratch, 0),
        tier1.map((r) => r.id),
      );
      replaceAll(
        scratch,
        0,
        tier1.map((r, i) => ({ ...r, id: mapped[i] })),
      );
    } catch (error) {
      if (
        error instanceof ContentEditError &&
        error.message.startsWith('Original-font replacement')
      )
        tier1 = null;
      else throw error;
    } finally {
      scratch.destroy();
    }
  }
  if (tier1) {
    const op = tier1.length
      ? ctx.mutate(args.docId, 'Edit paragraph', [args.pageId], (pdf) =>
          replaceAll(pdf, index, tier1!),
        )
      : ctx.result(args.docId, []);
    const currentId = tier1.length
      ? paragraphs(doc.pdf, index, interpretPage(doc.pdf, index)).find((q) => q.text === plain)?.id
      : p?.id;
    return {
      ...op,
      tier: 1,
      notices,
      overlap: false,
      paragraphId: currentId,
      lineCount: p!.lines.length,
      elapsedMs: performance.now() - start,
    };
  }
  if (p) validateTier2(model, p);
  const reflowState = p
    ? getTextReflowState(model, idsFor(p))
    : { clip: '', renderMode: 0 as const };
  const layout = await layoutParagraph(doc.pdf, model, p ? adjustedParagraph(p) : undefined, args);
  notices.push(...layout.notices);
  const overlap = overlapWarning(model, p, layout, args);
  if (overlap)
    notices.push(
      'The paragraph may overlap content below or exceed its frame. Widen the box or reduce the text size.',
    );
  const tag = p?.boxTag ?? `GarnetTextBox_${crypto.randomUUID().replace(/-/g, '')}`;
  const ids = p ? paragraphRuns(p).map((r) => r.id) : [];
  const scratch = scratchPage(doc.pdf, index);
  try {
    if (ids.length) removeParagraph(scratch, 0, mapRuns(model, interpretPage(scratch, 0), ids));
  } finally {
    scratch.destroy();
  }
  // Coverage, shaping, clip compatibility and deletion have all been validated.
  // Embed the prepared glyphs once. The operation journal rolls back any write failure.
  const result = ctx.mutate(
    args.docId,
    p ? 'Edit paragraph' : 'Add text box',
    [args.pageId],
    (pdf) => {
      if (ids.length) removeParagraph(pdf, index, ids);
      appendLayout(pdf, index, model, layout, tag, reflowState.renderMode, reflowState.clip);
      // The private tag identifies owned boxes even after save/reopen. Store dimensions separately
      // from ink bounds so a short line never silently shrinks a fixed-width frame.
      const page = pdf.findPage(index),
        meta = page.get('GarnetTextBoxes');
      const boxes = meta.isNull() ? pdf.newDictionary() : meta;
      const b = p ? paragraphBounds(p) : args.box!.bbox;
      boxes.put(
        tag,
        pdf.newString(
          JSON.stringify({
            bbox: [
              b[0],
              b[1],
              b[0] + layout.width,
              Math.max(
                b[3],
                (layout.lines.at(-1)?.baseline ?? b[3]) +
                  (args.style?.size ?? p?.dominantStyle.size ?? 12) * 0.3,
              ),
            ],
            leading: layout.leading,
            hangingIndent: p?.hangingIndent,
            alignment: args.alignment ?? p?.alignment ?? 'left',
            text: plain,
            autoWidth: args.box?.autoWidth ?? (args.width === undefined && p?.autoWidth) ?? false,
          }),
        ),
      );
      page.put('GarnetTextBoxes', boxes);
    },
  );
  return {
    ...result,
    tier: 2,
    notices: [...new Set(notices)],
    overlap,
    paragraphId: tag,
    lineCount: layout.lines.length,
    elapsedMs: performance.now() - start,
  };
}
async function preview(
  ctx: EngineContext,
  args: PageArgs & { paragraphId: string; scale?: number },
): Promise<TextPreviewResult> {
  const start = performance.now(),
    { doc, index, model } = pageModel(ctx, args),
    p = findParagraph(doc.pdf, index, model, args.paragraphId);
  if (p.readOnly) throw new Error(p.reason);
  fullScope(model, p);
  const scratch = scratchPage(doc.pdf, index);
  let png: ArrayBuffer, width: number, height: number;
  try {
    removeParagraph(
      scratch,
      0,
      mapRuns(
        model,
        interpretPage(scratch, 0),
        paragraphRuns(p).map((r) => r.id),
      ),
    );
    const page = scratch.loadPage(0),
      scale = Math.max(0.25, Math.min(4, args.scale ?? 1));
    try {
      const pix = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        png = Uint8Array.from(pix.asPNG()).buffer;
        width = pix.getWidth();
        height = pix.getHeight();
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    scratch.destroy();
  }
  const faces: TextPreviewResult['faces'] = [],
    notices: string[] = [];
  for (const key of new Set(paragraphRuns(p).map((r) => r.fontKey))) {
    const info = model.fonts[key],
      rs = paragraphRuns(p).filter((r) => r.fontKey === key);
    const value = rs.map((r) => r.actualText ?? r.text).join('');
    const font = await previewFont(
      doc.pdf,
      info,
      value,
      { ...defaultStyle, ...p.dominantStyle, fontKey: key, bold: info.bold, italic: info.italic },
      index,
    );
    faces.push({
      fontKey: key,
      family: font.family,
      bytes: Uint8Array.from(font.program).buffer,
      bold: font.bold,
      italic: font.italic,
    });
    if (font.notice) notices.push(font.notice);
  }
  return {
    png: png!,
    width: width!,
    height: height!,
    faces,
    notices: [...new Set(notices)],
    elapsedMs: performance.now() - start,
  };
}
export const namespace = 'text';
export const ops = {
  'text.paragraphs': (ctx: EngineContext, args: PageArgs): ParagraphsResult => {
    const { doc, index, model } = pageModel(ctx, args);
    return {
      revision: doc.revision,
      paragraphs: paragraphs(doc.pdf, index, model),
      fonts: Object.values(model.fonts),
      userToPage: model.userToPage,
      rotate: model.rotate,
    };
  },
  'text.registerFonts': (_ctx: EngineContext, args: { fonts: SystemFontInput[] }) => ({
    registered: registerSystemFonts(args.fonts),
  }),
  'text.preview': preview,
  'text.commit': commit,
  'text.transform': async (
    ctx: EngineContext,
    args: PageArgs & { paragraphIds: string[]; matrix: Matrix },
  ): Promise<OpResult> => {
    const { doc, model, index } = pageModel(ctx, args),
      ps = args.paragraphIds.map((id) => findParagraph(doc.pdf, index, model, id));
    // Host transforms use unrotated top-left coordinates.
    if (
      args.matrix[1] === 0 &&
      args.matrix[2] === 0 &&
      (args.matrix[0] !== 1 || args.matrix[3] !== 1)
    ) {
      if (ps.length !== 1) throw new Error('Resize one paragraph at a time.');
      const p = ps[0];
      return commit(ctx, {
        ...args,
        paragraphId: p.id,
        expectedRevision: ctx.get(args.docId).revision,
        spans: [{ text: p.text }],
        width: (paragraphBounds(p)[2] - paragraphBounds(p)[0]) * args.matrix[0],
      });
    }
    const toUser = userFromLayout(model),
      matrix = concat(concat(invert(toUser), args.matrix), toUser);
    return ctx.mutate(args.docId, 'Move paragraph', [args.pageId], (pdf) => {
      transformObjects(
        pdf,
        index,
        ps.flatMap((p) => paragraphRuns(p).map((r) => r.id)),
        matrix,
        { allowShapedText: true },
      );
      const boxes = pdf.findPage(index).get('GarnetTextBoxes');
      for (const p of ps) {
        if (!p.boxTag || boxes.isNull()) continue;
        const stored = boxes.get(p.boxTag);
        if (!stored.isString()) continue;
        const meta = JSON.parse(stored.asString());
        meta.bbox = transformRect(paragraphBounds(p), args.matrix);
        boxes.put(p.boxTag, pdf.newString(JSON.stringify(meta)));
      }
    });
  },
  'text.delete': (ctx: EngineContext, args: PageArgs & { paragraphIds: string[] }): OpResult => {
    const { doc, model, index } = pageModel(ctx, args),
      ps = args.paragraphIds.map((id) => findParagraph(doc.pdf, index, model, id));
    ps.forEach((p) => fullScope(model, p));
    return ctx.mutate(args.docId, 'Delete paragraph', [args.pageId], (pdf) =>
      removeParagraph(
        pdf,
        index,
        ps.flatMap((p) => paragraphRuns(p).map((r) => r.id)),
      ),
    );
  },
};
