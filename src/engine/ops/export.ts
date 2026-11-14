import * as mupdf from 'mupdf';
import { deepCopy, type EngineContext } from '../context';
import type { PageId } from '../../shared/engine-api';
import { placeImage, sniffImage, type PageSizeId } from '../tools/export/pages';

export interface RenderedPage { bytes: ArrayBuffer; width: number; height: number; mime: 'image/png' | 'image/jpeg' }
export interface ImageInput { name: string; bytes: ArrayBuffer }

declare module '../../shared/engine-api' {
  interface EngineOps {
    'export.renderPage': { args: { docId: string; pageId: PageId; dpi: number; format: 'png' | 'jpeg'; quality?: number; hiddenLayers?: number[] }; result: RenderedPage };
    'export.extractPages': { args: { docId: string; pageIds: PageId[] }; result: { bytes: ArrayBuffer; pageCount: number } };
    /** Builds a new PDF from images. The document named by docId only routes the call and is not changed. */
    'export.buildFromImages': { args: { docId: string; images: ImageInput[]; pageSize: PageSizeId; margin: number }; result: { bytes: ArrayBuffer; pageCount: number; failed: string[] } };
  }
}

const MAX_PIXELS = 120_000_000;

export const namespace = 'export';
export const ops = {
  'export.renderPage': (ctx: EngineContext, args: { docId: string; pageId: PageId; dpi: number; format: 'png' | 'jpeg'; quality?: number; hiddenLayers?: number[] }): RenderedPage => {
    if (!(args.dpi >= 36 && args.dpi <= 1200)) throw new Error('Choose a resolution between 36 and 1200 dpi.');
    const { pdf } = ctx.get(args.docId);
    const layerCount = args.hiddenLayers ? pdf.countLayers() : 0;
    const previous = Array.from({ length: layerCount }, (_, i) => pdf.isLayerVisible(i));
    for (let i = 0; i < layerCount; i++) pdf.setLayerVisible(i, !args.hiddenLayers!.includes(i));
    const page = pdf.loadPage(ctx.pageIndex(args.docId, args.pageId));
    try {
      const scale = args.dpi / 72;
      const bounds = page.getBounds();
      const pixels = Math.ceil((bounds[2] - bounds[0]) * scale) * Math.ceil((bounds[3] - bounds[1]) * scale);
      if (pixels > MAX_PIXELS) throw new Error(`Page ${ctx.pageIndex(args.docId, args.pageId) + 1} is too large at ${args.dpi} dpi. Choose a lower resolution.`);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        pixmap.setResolution(args.dpi, args.dpi);
        const encoded = args.format === 'jpeg' ? pixmap.asJPEG(Math.max(10, Math.min(100, args.quality ?? 90)), false) : pixmap.asPNG();
        return { bytes: Uint8Array.from(encoded).buffer, width: pixmap.getWidth(), height: pixmap.getHeight(), mime: args.format === 'jpeg' ? 'image/jpeg' : 'image/png' };
      } finally { pixmap.destroy(); }
    } finally {
      page.destroy();
      previous.forEach((visible, i) => pdf.setLayerVisible(i, visible));
    }
  },
  /** Copies the chosen pages, in document order, into a new PDF. The live document is only read. */
  'export.extractPages': (ctx: EngineContext, args: { docId: string; pageIds: PageId[] }) => {
    if (!args.pageIds.length) throw new Error('Choose at least one page.');
    const indices = [...new Set(args.pageIds.map(id => ctx.pageIndex(args.docId, id)))].sort((a, b) => a - b);
    const source = deepCopy(ctx.get(args.docId).pdf);
    const target = new mupdf.PDFDocument();
    try {
      const map = target.newGraftMap();
      for (const index of indices) map.graftPage(target.countPages(), source, index);
      map.destroy();
      const buffer = target.saveToBuffer('garbage=compact,compress,objstms');
      try { return { bytes: Uint8Array.from(buffer.asUint8Array()).buffer, pageCount: indices.length }; }
      finally { buffer.destroy(); }
    } finally { target.destroy(); source.destroy(); }
  },
  /**
   * One page per image page (multi-page TIFF gives several). Images open through MuPDF's image document handler,
   * which applies EXIF orientation; the PDF writer keeps JPEG data as it is.
   */
  'export.buildFromImages': (ctx: EngineContext, args: { docId: string; images: ImageInput[]; pageSize: PageSizeId; margin: number }) => {
    ctx.get(args.docId);
    if (!args.images.length) throw new Error('Choose at least one image.');
    const margin = Math.max(0, Math.min(144, args.margin));
    const failed: string[] = [];
    const buffer = new mupdf.Buffer();
    const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
    let pageCount = 0;
    try {
      for (const input of args.images) {
        const type = sniffImage(input.bytes);
        let doc: mupdf.Document;
        try {
          if (!type) throw new Error('Not an image');
          doc = mupdf.Document.openDocument(input.bytes, type);
        } catch { failed.push(input.name); continue; }
        try {
          for (let i = 0; i < doc.countPages(); i++) {
            const page = doc.loadPage(i);
            try {
              const b = page.getBounds();
              const w = b[2] - b[0], h = b[3] - b[1];
              if (!(w > 0 && h > 0)) continue;
              const { page: size, rect } = placeImage(w, h, args.pageSize, margin);
              const scale = rect[2] / w;
              const top = size[1] - rect[1] - rect[3];
              const device = writer.beginPage([0, 0, size[0], size[1]]);
              page.run(device, [scale, 0, 0, scale, rect[0] - b[0] * scale, top - b[1] * scale]);
              writer.endPage();
              pageCount++;
            } finally { page.destroy(); }
          }
        } catch { failed.push(input.name); }
        finally { doc.destroy(); }
      }
      if (!pageCount) throw new Error('None of the chosen files could be read as an image.');
      writer.close();
      return { bytes: Uint8Array.from(buffer.asUint8Array()).buffer, pageCount, failed };
    } finally {
      writer.destroy();
      buffer.destroy();
    }
  },
};
