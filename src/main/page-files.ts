/**
 * Writes several new PDFs (split parts, extracted pages) into one folder the user picks.
 * Names come from the renderer but are reduced to safe base names here; existing files are never
 * replaced (a " (2)" suffix is added instead). Each file is verified before it is renamed into
 * place, like a normal save.
 */
import { dialog, type BrowserWindow } from 'electron';
import { access } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { saveAtomically } from './atomic-save';
import { verifyPdf } from './verify-pdf';
import type { FileStore } from './file-store';
import type { SaveFilesRequest, SaveFilesResult } from '../shared/ipc';

export const saveFilesSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(250),
        bytes: z.instanceof(ArrayBuffer),
        expectedPageCount: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(2000),
  title: z.string().max(120).optional(),
  nearHandle: z.string().uuid().optional(),
});

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeBaseName(name: string): string {
  let stem = basename(name.replace(/\\/g, '/'))
    .replace(/\.pdf$/i, '')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!stem) stem = 'Document';
  if (RESERVED.test(stem.split('.')[0])) stem = `_${stem}`;
  return `${stem.slice(0, 180).trim()}.pdf`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function saveFilesToFolder(
  window: BrowserWindow,
  fileStore: FileStore,
  request: SaveFilesRequest,
): Promise<SaveFilesResult | null> {
  let defaultPath: string | undefined;
  if (request.nearHandle) {
    try {
      defaultPath = dirname(fileStore.path(request.nearHandle));
    } catch {
      defaultPath = undefined;
    }
  }
  const picked = await dialog.showOpenDialog(window, {
    title: request.title || 'Choose a folder for the new files',
    buttonLabel: 'Save here',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const folder = picked.filePaths[0];
  const used = new Set<string>();
  const files = [];
  for (const file of request.files) {
    const safe = safeBaseName(file.name);
    const stem = safe.slice(0, -4);
    let candidate = safe;
    for (let k = 2; used.has(candidate.toLowerCase()) || (await exists(join(folder, candidate))); k++)
      candidate = `${stem} (${k}).pdf`;
    used.add(candidate.toLowerCase());
    const path = join(folder, candidate);
    await saveAtomically(path, new Uint8Array(file.bytes), (data) =>
      verifyPdf(data, file.expectedPageCount),
    );
    files.push(await fileStore.descriptor(path));
  }
  return { folderName: basename(folder), files };
}
