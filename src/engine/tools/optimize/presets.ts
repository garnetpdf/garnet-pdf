/** Reduce file size settings. Pure data and arithmetic shared by the dialog, engine and tests. */
export type PresetId = 'high' | 'balanced' | 'smallest' | 'custom';
export interface ReduceSettings {
  /** Images drawn above this resolution are downsampled. */
  thresholdDpi: number;
  /** Resolution of downsampled images. */
  targetDpi: number;
  /** JPEG quality, 1-100. */
  jpegQuality: number;
  /** Re-encode lossless photos (Flate, LZW and similar) as JPEG when that is smaller. */
  convertLossless: boolean;
  grayscale: boolean;
  subsetFonts: boolean;
  removeMetadata: boolean;
  removeThumbnails: boolean;
  removeAttachments: boolean;
}
export const MIN_IMAGE_BYTES = 20 * 1024;
/** A re-encoded image replaces the original only when it saves at least this share of its bytes. */
export const MIN_SAVING = 0.03;

const common = { grayscale: false, subsetFonts: true, removeMetadata: false, removeThumbnails: true, removeAttachments: false };
export const PRESETS: Record<Exclude<PresetId, 'custom'>, ReduceSettings & { label: string; hint: string }> = {
  high: { ...common, label: 'High quality', hint: 'Keeps print quality. Images above 450 dpi go to 300 dpi.', thresholdDpi: 450, targetDpi: 300, jpegQuality: 90, convertLossless: false },
  balanced: { ...common, label: 'Balanced', hint: 'Good on screen and for office printing. Images above 200 dpi go to 150 dpi.', thresholdDpi: 200, targetDpi: 150, jpegQuality: 72, convertLossless: true },
  smallest: { ...common, label: 'Smallest', hint: 'For email and upload limits. Images above 120 dpi go to 100 dpi.', thresholdDpi: 120, targetDpi: 100, jpegQuality: 60, convertLossless: true },
};

export function settingsProblem(settings: ReduceSettings): string | null {
  if (!(settings.targetDpi >= 36 && settings.targetDpi <= 1200)) return 'Choose a target resolution between 36 and 1200 dpi.';
  if (!(settings.thresholdDpi >= settings.targetDpi && settings.thresholdDpi <= 2400)) return 'The threshold must be at least the target resolution.';
  if (!(settings.jpegQuality >= 10 && settings.jpegQuality <= 100)) return 'Choose a JPEG quality between 10 and 100.';
  return null;
}

/** Effective resolution of an image drawn at `drawnWidth` x `drawnHeight` points. */
export function effectiveDpi(pixelWidth: number, pixelHeight: number, drawnWidth: number, drawnHeight: number): number {
  const x = drawnWidth > 0 ? pixelWidth / (drawnWidth / 72) : Infinity;
  const y = drawnHeight > 0 ? pixelHeight / (drawnHeight / 72) : Infinity;
  return Math.min(x, y);
}

/** Target pixel size for an image, or null when it should keep its size. */
export function downsampleSize(pixelWidth: number, pixelHeight: number, drawnWidth: number, drawnHeight: number, settings: Pick<ReduceSettings, 'thresholdDpi' | 'targetDpi'>): { width: number; height: number } | null {
  const dpi = effectiveDpi(pixelWidth, pixelHeight, drawnWidth, drawnHeight);
  if (!Number.isFinite(dpi) || dpi <= settings.thresholdDpi) return null;
  const factor = settings.targetDpi / dpi;
  const width = Math.max(1, Math.round(pixelWidth * factor));
  const height = Math.max(1, Math.round(pixelHeight * factor));
  return width < pixelWidth && height < pixelHeight ? { width, height } : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}
