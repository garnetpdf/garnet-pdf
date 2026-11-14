import { constants } from 'node:fs';
import { access, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class SaveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SaveError';
  }
}

export async function saveAtomically(
  target: string,
  bytes: Uint8Array,
  verify: (bytes: Uint8Array) => Promise<void> | void,
  options: { beforeRename?: () => Promise<void> | void } = {},
): Promise<void> {
  const folder = dirname(target);
  let originalMode: number | undefined;
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error('Not a folder');
    await access(folder, constants.W_OK);
  } catch (cause) {
    throw new SaveError('The destination folder is missing or cannot be written.', { cause });
  }
  try {
    const original = await stat(target);
    if (!original.isFile()) throw new SaveError('The destination is not a file.');
    // access(W_OK) alone reports writable for root on Unix, so honour mode bits too.
    if ((original.mode & 0o222) === 0) throw new SaveError('The file is read-only. Use Save As.');
    originalMode = original.mode & 0o777;
    await access(target, constants.W_OK);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (cause instanceof SaveError) throw cause;
      throw new SaveError('The file is locked or cannot be written. Use Save As.', { cause });
    }
  }

  const temporary = join(folder, `${basename(target)}.garnet-tmp-${randomUUID()}`);
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(bytes);
      if (originalMode !== undefined) await file.chmod(originalMode);
      await file.sync();
    } finally {
      await file.close();
    }
    await verify(new Uint8Array(await readFile(temporary)));
    await options.beforeRename?.();
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, target);
        break;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(code || '') || attempt >= 5)
          throw new SaveError(
            'The file is locked or could not be replaced. The original is unchanged.',
            { cause },
          );
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    created = false;
    // Directory fsync is supported on Unix. Windows can reject opening a directory.
    try {
      const directory = await open(folder, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The file itself was synced and renamed successfully.
    }
  } catch (cause) {
    if (cause instanceof SaveError) throw cause;
    throw new SaveError('The file could not be saved. The original is unchanged.', { cause });
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}
