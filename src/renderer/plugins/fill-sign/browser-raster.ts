/** HTML canvas implementation of the raster factory, and the bundled signature fonts. */
import greatVibes from '../../../../resources/fonts/GreatVibes-Regular.ttf?url';
import dancingScript from '../../../../resources/fonts/DancingScript-Variable.ttf?url';
import arefRuqaa from '../../../../resources/fonts/ArefRuqaa-Regular.ttf?url';
import arefRuqaaBold from '../../../../resources/fonts/ArefRuqaa-Bold.ttf?url';
import type { RasterFactory, RasterSurface } from './raster';

export const browserRaster: RasterFactory = {
  create(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  },
  async encodePng(surface: RasterSurface) {
    const blob = await new Promise<Blob>((resolve, reject) =>
      (surface as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('The picture could not be created.'))),
        'image/png',
      ),
    );
    return blob.arrayBuffer();
  },
  async decode(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
};

export interface SignatureFont {
  id: string;
  label: string;
  family: string;
  weight: string;
}
export const SIGNATURE_FONTS: SignatureFont[] = [
  { id: 'great-vibes', label: 'Great Vibes', family: 'Garnet Great Vibes', weight: '400' },
  { id: 'dancing', label: 'Dancing Script', family: 'Garnet Dancing Script', weight: '500' },
  { id: 'dancing-bold', label: 'Dancing Script Bold', family: 'Garnet Dancing Script', weight: '700' },
  { id: 'ruqaa', label: 'Aref Ruqaa', family: 'Garnet Aref Ruqaa', weight: '400' },
];

let loading: Promise<void> | null = null;
/** Loads the bundled script fonts from the app itself (no network). */
export function loadSignatureFonts(): Promise<void> {
  loading ??= (async () => {
    const faces: [string, string, FontFaceDescriptors][] = [
      ['Garnet Great Vibes', greatVibes, { weight: '400' }],
      ['Garnet Dancing Script', dancingScript, { weight: '400 700' }],
      ['Garnet Aref Ruqaa', arefRuqaa, { weight: '400' }],
      ['Garnet Aref Ruqaa', arefRuqaaBold, { weight: '700' }],
    ];
    await Promise.all(
      faces.map(async ([family, url, descriptors]) => {
        const bytes = await (await fetch(url)).arrayBuffer();
        const face = new FontFace(family, bytes, descriptors);
        await face.load();
        document.fonts.add(face);
      }),
    );
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}
