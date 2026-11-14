/** Page range parsing and export file naming. Pure functions. */
export class PageRangeError extends Error {}

/** Parses "1-3, 5, 8-" into zero-based page indices in document order, without duplicates. */
export function parsePageRange(text: string, pageCount: number): number[] {
  const trimmed = text.trim();
  if (!trimmed || /^all$/i.test(trimmed)) return Array.from({ length: pageCount }, (_, i) => i);
  const result = new Set<number>();
  for (const part of trimmed.split(',')) {
    const value = part.trim();
    if (!value) continue;
    const match = value.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!match || (!match[1] && !match[3])) throw new PageRangeError(`"${value}" is not a page or range.`);
    const from = match[1] ? Number(match[1]) : 1;
    const to = match[2] ? (match[3] ? Number(match[3]) : pageCount) : from;
    if (from < 1 || to > pageCount || from > to) throw new PageRangeError(`Pages ${value} are outside 1-${pageCount}.`);
    for (let page = from; page <= to; page++) result.add(page - 1);
  }
  if (!result.size) throw new PageRangeError('Choose at least one page.');
  return [...result].sort((a, b) => a - b);
}

export function safeBaseName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (cleaned || 'Document').slice(0, 120);
}

/** "{name}" document name, "{page}" page number (zero padded to the page count), "{label}" page label. */
export function exportFileName(pattern: string, documentName: string, pageIndex: number, pageCount: number, label: string, extension: string): string {
  const width = String(pageCount).length;
  const page = String(pageIndex + 1).padStart(width, '0');
  const raw = (pattern.trim() || '{name}-{page}')
    .replaceAll('{name}', safeBaseName(documentName))
    .replaceAll('{page}', page)
    .replaceAll('{label}', label || String(pageIndex + 1));
  return `${safeBaseName(raw)}.${extension}`;
}

export const PAGE_SIZES = {
  fit: null,
  a4: [595.28, 841.89] as [number, number],
  letter: [612, 792] as [number, number],
} as const;
export type PageSizeId = keyof typeof PAGE_SIZES;

/** Places an image of `w` x `h` (points at its own resolution) on a page. Returns the page size and image rectangle (user space, bottom-left origin). */
export function placeImage(w: number, h: number, size: PageSizeId, margin: number): { page: [number, number]; rect: [number, number, number, number] } {
  const fixed = PAGE_SIZES[size];
  if (!fixed) return { page: [w + 2 * margin, h + 2 * margin], rect: [margin, margin, w, h] };
  const landscape = w > h;
  const [pw, ph] = landscape ? [fixed[1], fixed[0]] : fixed;
  const boxW = Math.max(1, pw - 2 * margin), boxH = Math.max(1, ph - 2 * margin);
  const scale = Math.min(boxW / w, boxH / h, 1);
  const iw = w * scale, ih = h * scale;
  return { page: [pw, ph], rect: [(pw - iw) / 2, (ph - ih) / 2, iw, ih] };
}

/** Image type from the file's first bytes, or null when it is not an image MuPDF can place on a page. */
export function sniffImage(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength));
  const ascii = (start: number, text: string) => [...text].every((c, i) => b[start + i] === c.charCodeAt(0));
  if (b[0] === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'BM')) return 'image/bmp';
  if ((ascii(0, 'II') && b[2] === 42 && b[3] === 0) || (ascii(0, 'MM') && b[2] === 0 && b[3] === 42)) return 'image/tiff';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if ((b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 12 && ascii(4, 'jP  ')) || (b[0] === 0xff && b[1] === 0x4f && b[2] === 0xff && b[3] === 0x51)) return 'image/jp2';
  return null;
}
