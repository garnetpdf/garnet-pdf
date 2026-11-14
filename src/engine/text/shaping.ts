import createHB from 'harfbuzzjs/hb.js';
import wrapHB, {
  type HarfBuzz,
  type HBGlyph,
  type HBBlob,
  type HBFace,
  type HBFont,
} from 'harfbuzzjs/hbjs.js';
import wasmURL from 'harfbuzzjs/hb.wasm?url';

/** Only bundled app: assets in production. The Node branch is for the test helper. */
export async function readAsset(url: string): Promise<Uint8Array> {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const local = /^\/(node_modules|resources)\//.test(url) ? `${process.cwd()}${url}` : url;
    return Uint8Array.from(await readFile(local));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('A bundled font could not be loaded.');
  return new Uint8Array(await response.arrayBuffer());
}
let pending: Promise<HarfBuzz> | undefined;
export const harfbuzz = () =>
  (pending ??= readAsset(wasmURL)
    .then((wasmBinary) => createHB({ wasmBinary }))
    .then(wrapHB));
export function isOpenType(program: Uint8Array): boolean {
  const tag = String.fromCharCode(...program.subarray(0, 4));
  return tag === '\u0000\u0001\u0000\u0000' || tag === 'OTTO' || tag === 'true' || tag === 'ttcf';
}
interface FaceRecord {
  blob: HBBlob;
  face: HBFace;
  font: HBFont;
  unicodes?: Set<number>;
}
const faces = new Map<Uint8Array, FaceRecord>();
function faceFor(hb: HarfBuzz, program: Uint8Array): FaceRecord {
  const cached = faces.get(program);
  if (cached) {
    faces.delete(program);
    faces.set(program, cached);
    return cached;
  }
  const bytes =
    program.byteOffset === 0 &&
    program.buffer instanceof ArrayBuffer &&
    program.byteLength === program.buffer.byteLength
      ? program.buffer
      : Uint8Array.from(program).buffer;
  const blob = hb.createBlob(bytes),
    face = hb.createFace(blob, 0),
    font = hb.createFont(face);
  font.setScale(face.upem, face.upem);
  const record = { blob, face, font };
  faces.set(program, record);
  while (faces.size > 12) {
    const [key, old] = faces.entries().next().value!;
    faces.delete(key);
    old.font.destroy();
    old.face.destroy();
    old.blob.destroy();
  }
  return record;
}
export async function shape(
  program: Uint8Array,
  text: string,
  size: number,
  direction: 'ltr' | 'rtl',
  charSpacing = 0,
): Promise<{ glyphs: HBGlyph[]; width: number; upem: number }> {
  const hb = await harfbuzz(),
    { face, font } = faceFor(hb, program),
    buffer = hb.createBuffer();
  try {
    buffer.addText(text);
    buffer.guessSegmentProperties();
    buffer.setDirection(direction);
    hb.shape(font, buffer);
    const raw = buffer.json(),
      factor = size / face.upem;
    // Letter spacing belongs to cluster boundaries, never inside a combining cluster.
    const glyphs = raw.map((g, i) => ({
      ...g,
      ax: g.ax * factor + (i === raw.length - 1 || raw[i + 1].cl !== g.cl ? charSpacing : 0),
      ay: g.ay * factor,
      dx: g.dx * factor,
      dy: g.dy * factor,
    }));
    return { glyphs, width: glyphs.reduce((n, g) => n + g.ax, 0), upem: face.upem };
  } finally {
    buffer.destroy();
  }
}
export async function supports(program: Uint8Array, text: string): Promise<boolean> {
  if (!isOpenType(program)) return false;
  const hb = await harfbuzz(),
    record = faceFor(hb, program);
  const supported = (record.unicodes ??= new Set(record.face.collectUnicodes()));
  const nonPainting = new Set(
    '\n\r\t\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069',
  );
  if ([...text].some((c) => !nonPainting.has(c) && !supported.has(c.codePointAt(0)!))) return false;
  const shaped = await shape(
    program,
    text,
    12,
    /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(text) ? 'rtl' : 'ltr',
  );
  return shaped.glyphs.every((g) => g.g !== 0);
}
