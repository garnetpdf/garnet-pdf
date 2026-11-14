import { flattenObjects, interpretPage, type PageObject } from '@garnet/pdf-content';
import type { EngineContext } from '../context';
import type { PageId, Rect } from '../../shared/engine-api';

/**
 * Read-only bridge from the engine worker to the content model package (`@garnet/pdf-content`).
 * Edit providers (text, objects) may call it for hit testing and inspectors; edits themselves go
 * through their own ops so each gesture stays one journal step.
 */
export interface ContentObjectSummary {
  id: string;
  kind: PageObject['kind'];
  z: number;
  /** Default PDF user space (before CropBox/Rotate). */
  bbox: Rect;
  /** MuPDF page space: top-left origin, y down, rotation applied. Use for overlays. */
  pageBBox: Rect;
  clipBBox?: Rect;
  renderBBox: Rect;
  editability: PageObject['editability'];
  formPath: string[];
  text?: string;
  fontName?: string;
  fontSize?: number;
  image?: { width: number; height: number; hasSMask: boolean; filter: string[] };
}

export interface ContentObjectsResult {
  /** Engine document revision the summary was computed at. */
  revision: number;
  /** Content fingerprint from the content model (changes whenever any interpreted stream changes). */
  contentRevision: string;
  rotate: 0 | 90 | 180 | 270;
  objects: ContentObjectSummary[];
  warnings: string[];
}

declare module '../../shared/engine-api' {
  interface EngineOps {
    'content.objects': { args: { docId: string; pageId: PageId }; result: ContentObjectsResult };
  }
}

function summarise(object: PageObject, fonts: Record<string, { baseName: string }>): ContentObjectSummary {
  const summary: ContentObjectSummary = {
    id: object.id,
    kind: object.kind,
    z: object.z,
    bbox: object.bbox,
    pageBBox: object.pageBBox,
    renderBBox: object.renderBBox,
    editability: object.editability,
    formPath: object.formPath,
  };
  if (object.clipBBox) summary.clipBBox = object.clipBBox;
  if (object.kind === 'text') {
    summary.text = object.actualText ?? object.text;
    summary.fontName = fonts[object.fontKey]?.baseName;
    summary.fontSize = object.size;
  } else if (object.kind === 'image') {
    summary.image = { width: object.width, height: object.height, hasSMask: object.hasSMask, filter: object.filter };
  }
  return summary;
}

export const namespace = 'content';
export const ops = {
  'content.objects': (ctx: EngineContext, args: { docId: string; pageId: PageId }): ContentObjectsResult => {
    const doc = ctx.get(args.docId);
    const index = ctx.pageIndex(args.docId, args.pageId);
    const model = interpretPage(doc.pdf, index);
    return {
      revision: doc.revision,
      contentRevision: model.revision,
      rotate: model.rotate,
      objects: flattenObjects(model.objects).map((object) => summarise(object, model.fonts)),
      warnings: model.warnings,
    };
  },
};
