import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { extname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as fontkit from 'fontkit';
import type { FontEntry } from '../shared/ipc';

const exec = promisify(execFile);
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);
/** The engine refuses a font above 32 MB; nothing larger is worth sending to it. */
const MAX_FONT_BYTES = 64 * 1024 * 1024;

/**
 * The folders the system keeps its fonts in.
 * A Mac has no `fc-list`: its fonts are in these four folders, many of them as collections
 * (`.ttc`, `.otc`: several fonts in one file, for example Helvetica with all its weights).
 * On Linux this is the fallback for a machine without `fc-list`.
 */
export function fontFolders(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'win32')
    return [
      win32.join(env.WINDIR || 'C:\\Windows', 'Fonts'),
      ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')] : []),
    ];
  if (platform === 'darwin')
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      posix.join(home, 'Library', 'Fonts'),
    ];
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    posix.join(home, '.local', 'share', 'fonts'),
  ];
}

async function walk(folder: string, found: Set<string>, depth = 0): Promise<void> {
  if (depth > 4) return;
  let rows;
  try {
    rows = await readdir(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const row of rows) {
    const path = join(folder, row.name);
    if (row.isDirectory()) await walk(path, found, depth + 1);
    else if (row.isFile() && FONT_EXTENSIONS.has(extname(row.name).toLowerCase())) found.add(path);
  }
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Font file ends too early.');
  return buffer;
}

const SFNT_TAGS = new Set(['\u0000\u0001\u0000\u0000', 'OTTO', 'true']);

/** Where each font of the file starts: one entry for a plain font, several for a collection. */
async function faceOffsets(file: FileHandle): Promise<{ collection: boolean; offsets: number[] }> {
  const head = await readAt(file, 0, 12);
  const tag = head.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const count = head.readUInt32BE(8);
    if (count < 1 || count > 512) throw new Error('Font collection is damaged.');
    const table = await readAt(file, 12, count * 4);
    return {
      collection: true,
      offsets: Array.from({ length: count }, (_, i) => table.readUInt32BE(i * 4)),
    };
  }
  if (!SFNT_TAGS.has(tag)) throw new Error('Not a TrueType or OpenType font.');
  return { collection: false, offsets: [0] };
}

function checksum(data: Buffer): number {
  let sum = 0;
  const whole = data.length - (data.length % 4);
  for (let i = 0; i < whole; i += 4) sum = (sum + data.readUInt32BE(i)) >>> 0;
  if (whole < data.length) {
    const tail = Buffer.alloc(4);
    data.copy(tail, 0, whole);
    sum = (sum + tail.readUInt32BE(0)) >>> 0;
  }
  return sum;
}

/** Writes tables as one complete font file (table list in tag order, tables on 4-byte boundaries). */
export function buildFont(version: Buffer, tables: Array<{ tag: string; data: Buffer }>): Buffer {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const count = sorted.length;
  const power = count ? Math.floor(Math.log2(count)) : 0;
  let offset = 12 + 16 * count;
  const places = sorted.map((table) => {
    const at = offset;
    offset += table.data.length + ((4 - (table.data.length % 4)) % 4);
    return at;
  });
  const out = Buffer.alloc(offset);
  version.copy(out, 0, 0, 4);
  out.writeUInt16BE(count, 4);
  out.writeUInt16BE(count ? 16 * 2 ** power : 0, 6);
  out.writeUInt16BE(power, 8);
  out.writeUInt16BE(count ? 16 * count - 16 * 2 ** power : 0, 10);
  let head = -1;
  sorted.forEach((table, i) => {
    const data = Buffer.from(table.data);
    // The checksum of the whole file is stored inside `head`; it counts as zero while summing.
    if (table.tag === 'head' && data.length >= 12) {
      data.writeUInt32BE(0, 8);
      head = places[i];
    }
    const entry = 12 + 16 * i;
    out.write(table.tag.padEnd(4, ' '), entry, 4, 'latin1');
    out.writeUInt32BE(checksum(data), entry + 4);
    out.writeUInt32BE(places[i], entry + 8);
    out.writeUInt32BE(data.length, entry + 12);
    data.copy(out, places[i]);
  });
  if (head >= 0) out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, head + 8);
  return out;
}

/**
 * One font of a file as a complete font file of its own. `only` keeps just the named tables
 * (the list of fonts needs nothing but the names, so a 180 MB collection costs a few small reads).
 */
async function readFace(file: FileHandle, offset: number, only?: string[]): Promise<Buffer> {
  const header = await readAt(file, offset, 12);
  if (!SFNT_TAGS.has(header.toString('latin1', 0, 4)))
    throw new Error('Not a TrueType or OpenType font.');
  const count = header.readUInt16BE(4);
  if (count < 1 || count > 512) throw new Error('Font is damaged.');
  const directory = await readAt(file, offset + 12, count * 16);
  const tables: Array<{ tag: string; data: Buffer }> = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const tag = directory.toString('latin1', i * 16, i * 16 + 4);
    if (only && !only.includes(tag)) continue;
    const length = directory.readUInt32BE(i * 16 + 12);
    total += length;
    if (total > MAX_FONT_BYTES) throw new Error('Font file is too large.');
    tables.push({ tag, data: await readAt(file, directory.readUInt32BE(i * 16 + 8), length) });
  }
  return buildFont(header, tables);
}

/** Family and style of every font in a file, read without loading the rest of the file. */
export async function faceNames(
  path: string,
): Promise<Array<{ family: string; style: string; collection: boolean }>> {
  const file = await open(path, 'r');
  try {
    const { collection, offsets } = await faceOffsets(file);
    const faces = [];
    for (const offset of offsets) {
      const font = fontkit.create(await readFace(file, offset, ['name']));
      if ('fonts' in font) throw new Error('Font collection inside a collection.');
      faces.push({
        family: font.familyName || font.postscriptName || 'Unknown',
        style: font.subfamilyName || 'Regular',
        collection,
      });
    }
    return faces;
  } finally {
    await file.close();
  }
}

/**
 * The bytes of one font. A font that lives in a collection comes out as a font file of its own:
 * the text engine reads the first font of whatever it is given, so the whole collection would
 * always give the first one (Helvetica Regular for a request for Helvetica Bold).
 */
export async function faceBytes(path: string, index: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const { collection, offsets } = await faceOffsets(file);
    if (index < 0 || index >= offsets.length) throw new Error('Font is no longer available.');
    if (collection) return await readFace(file, offsets[index]);
    const { size } = await file.stat();
    if (size > MAX_FONT_BYTES) throw new Error('Font file is too large.');
    return await readAt(file, 0, size);
  } finally {
    await file.close();
  }
}

const USUAL_STYLE =
  /^(regular|normal|book|roman|plain|bold|italic|oblique|bold italic|bold oblique)$/i;

/** PDF files name a font without spaces (GeezaPro for Geeza Pro). */
const spaceless = (family: string): string => family.replace(/[\s-]+/g, '');

export class FontStore {
  private faces = new Map<string, { path: string; index: number }>();
  private cached: FontEntry[] | null = null;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    /** Folders to read instead of the system's own (for tests). */
    private readonly folders?: string[],
  ) {}

  private async paths(): Promise<Set<string>> {
    const paths = new Set<string>();
    if (!this.folders && this.platform === 'linux') {
      try {
        const { stdout } = await exec('fc-list', ['-f', '%{file}\n'], {
          timeout: 10000,
          maxBuffer: 4_000_000,
        });
        stdout
          .split('\n')
          .filter(Boolean)
          .forEach((path) => paths.add(path));
        return paths;
      } catch {
        /* No fc-list on this machine: read the usual folders instead. */
      }
    }
    for (const folder of this.folders ?? fontFolders(this.platform)) await walk(folder, paths);
    return paths;
  }

  async list(): Promise<FontEntry[]> {
    if (this.cached) return this.cached;
    const rows: FontEntry[] = [];
    for (const path of await this.paths()) {
      try {
        (await faceNames(path)).forEach((face, index) => {
          // Names that start with a dot are the system's private interface fonts.
          if (face.family.startsWith('.')) return;
          const handle = randomUUID();
          this.faces.set(handle, { path, index });
          rows.push({ handle, family: face.family, style: face.style });
          // On a Mac the same font is also listed under the name PDF files use for it, so that text
          // set in Geeza Pro or Helvetica Neue is edited in that font and not in a substitute.
          const alias = spaceless(face.family);
          if (this.platform === 'darwin' && alias !== face.family)
            rows.push({ handle, family: alias, style: face.style });
        });
      } catch {
        /* Broken fonts and other kinds of file are skipped. */
      }
    }
    // On a Mac the four usual styles of a family come first. The text editor takes the first font of a
    // family that fits a request, and Mac families have many more styles (Helvetica has Light,
    // Helvetica Neue has Thin and UltraLight): without this, plain text was set in Light.
    const usual = (style: string): number =>
      this.platform === 'darwin' && !USUAL_STYLE.test(style.trim()) ? 1 : 0;
    this.cached = rows.sort(
      (a, b) =>
        a.family.localeCompare(b.family) ||
        usual(a.style) - usual(b.style) ||
        a.style.localeCompare(b.style),
    );
    return this.cached;
  }

  async read(handle: string): Promise<ArrayBuffer> {
    const face = this.faces.get(handle);
    if (!face) throw new Error('Font is no longer available. Refresh the font list.');
    const bytes = await faceBytes(face.path, face.index);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
