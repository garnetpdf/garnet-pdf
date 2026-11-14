export interface PrintPageLayout {
  pageRule: string;
  sectionWidth: string;
  sectionHeight: string;
  imageFit: string;
}

/** PDF page dimensions arrive in points, independent of the 300 dpi raster resolution. */
export function printPageLayout(
  index: number,
  widthPt: number,
  heightPt: number,
  sizing: 'actual' | 'fit' = 'actual',
): PrintPageLayout {
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt) || widthPt <= 0 || heightPt <= 0)
    throw new Error('Invalid PDF page dimensions.');
  if (sizing === 'fit')
    return {
      pageRule: `@page page${index}{size:auto;margin:0}`,
      sectionWidth: '100%',
      sectionHeight: 'auto',
      imageFit: 'contain',
    };
  return {
    pageRule: `@page page${index}{size:${widthPt}pt ${heightPt}pt;margin:0}`,
    sectionWidth: `${widthPt}pt`,
    sectionHeight: `${heightPt}pt`,
    imageFit: 'fill',
  };
}
