import { dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { saveAtomically } from '../atomic-save';
import { verifyPdf } from '../verify-pdf';
import type { P4bFileKind, P4bPickedFile } from './p4b-contract';

type Handle = <T extends z.ZodTypeAny>(
  channel: string,
  schema: T,
  run: (value: z.infer<T>) => Promise<unknown> | unknown,
) => void;

const MAX_PICKED_BYTES = 512 * 1024 * 1024;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'gif', 'webp', 'jp2', 'jpx'];
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Picked folders by token. Paths never cross into the renderer. */
const folders = new Map<string, string>();

/** A single safe file name: no folders, no characters Windows rejects, no reserved device names. */
export function safeFileName(name: string): string {
  let clean = basename(name.replaceAll('\\', '/'))
    .replace(/[<>:"/\\|?*\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!clean || clean.startsWith('.')) clean = `Export${clean}`;
  const extension = extname(clean);
  const stem = clean.slice(0, clean.length - extension.length);
  if (RESERVED.test(stem)) clean = `${stem}_${extension}`;
  if (clean.length > 200) clean = clean.slice(0, 200 - extension.length) + extension;
  return clean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function freeName(folder: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${extension}`;
    if (!(await exists(join(folder, candidate)))) return candidate;
  }
  throw new Error('Too many files with this name in the folder.');
}

function verifier(kind: P4bFileKind, expectedPageCount?: number) {
  return async (data: Uint8Array) => {
    if (
      kind === 'png' &&
      !(data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
    )
      throw new Error('The image could not be written.');
    if (kind === 'jpeg' && !(data[0] === 0xff && data[1] === 0xd8))
      throw new Error('The image could not be written.');
    if (kind === 'pdf') {
      if (expectedPageCount === undefined)
        throw new Error('The page count is needed to check the saved PDF.');
      await verifyPdf(data, expectedPageCount);
    }
  };
}

const FILTERS: Record<P4bFileKind, Electron.FileFilter[]> = {
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
  png: [{ name: 'PNG image', extensions: ['png'] }],
  jpeg: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }],
  any: [{ name: 'All files', extensions: ['*'] }],
};
const kind = z.enum(['pdf', 'png', 'jpeg', 'any']);
const bytes = z.instanceof(ArrayBuffer);
const pages = z.number().int().positive().max(100000).optional();

/** Registers these file channels with the zod-validated, sender-checked handler. */
export function registerP4bIpc(handle: Handle, window: () => BrowserWindow | null): void {
  handle('p4b-pick-folder', z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window()!, {
      title: 'Choose a folder for the exported files',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const token = randomUUID();
    folders.set(token, result.filePaths[0]);
    return { token, name: basename(result.filePaths[0]) || result.filePaths[0] };
  });
  handle(
    'p4b-write-file',
    z
      .object({
        token: z.string().uuid(),
        name: z.string().min(1).max(250),
        bytes,
        kind: kind.exclude(['any']),
        expectedPageCount: pages,
      })
      .strict(),
    async (request) => {
      const folder = folders.get(request.token);
      if (!folder) throw new Error('Choose the folder again.');
      const name = await freeName(folder, safeFileName(request.name));
      await saveAtomically(
        join(folder, name),
        new Uint8Array(request.bytes),
        verifier(request.kind, request.expectedPageCount),
      );
      return { name };
    },
  );
  handle(
    'p4b-save-as',
    z
      .object({ suggestedName: z.string().max(250), bytes, kind, expectedPageCount: pages })
      .strict(),
    async (request) => {
      const result = await dialog.showSaveDialog(window()!, {
        title: 'Save As',
        defaultPath: safeFileName(request.suggestedName || 'Export'),
        filters: FILTERS[request.kind],
      });
      if (result.canceled || !result.filePath) return null;
      await saveAtomically(
        result.filePath,
        new Uint8Array(request.bytes),
        verifier(request.kind, request.expectedPageCount),
      );
      return { name: basename(result.filePath) };
    },
  );
  handle(
    'p4b-pick-files',
    z.object({ purpose: z.enum(['images', 'any']) }).strict(),
    async (request) => {
      const result = await dialog.showOpenDialog(window()!, {
        title: request.purpose === 'images' ? 'Choose images' : 'Choose files to attach',
        properties: ['openFile', 'multiSelections'],
        filters:
          request.purpose === 'images'
            ? [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
            : FILTERS.any,
      });
      if (result.canceled) return [];
      const files: P4bPickedFile[] = [];
      let total = 0;
      for (const path of result.filePaths) {
        const info = await stat(path);
        if (!info.isFile()) continue;
        total += info.size;
        if (total > MAX_PICKED_BYTES)
          throw new Error('The chosen files are larger than 512 MB in total.');
        const data = await readFile(path);
        files.push({
          name: basename(path),
          bytes: data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer,
        });
      }
      return files;
    },
  );
}
