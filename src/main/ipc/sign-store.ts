/** Main-process IPC for the encrypted Fill & Sign store (channels sign-store-load / sign-store-save). */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { z } from 'zod';
import { createSignStore, itemsSchema } from './sign-store-core';

type Handle = <T extends z.ZodTypeAny>(
  channel: string,
  schema: T,
  run: (value: z.infer<T>) => unknown,
) => void;

export function registerSignStore(handle: Handle): void {
  const store = createSignStore(join(app.getPath('userData'), 'fill-sign', 'store.bin'), {
    async availability() {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        return { ok: false, reason: 'This computer cannot encrypt saved signatures.' };
      // Linux without a keyring falls back to a fixed key; refuse it unless explicitly allowed
      // (the automated tests set GARNET_ALLOW_BASIC_TEXT_KEYRING=1 in their throwaway profile).
      if (
        process.platform === 'linux' &&
        ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()) &&
        process.env.GARNET_ALLOW_BASIC_TEXT_KEYRING !== '1'
      )
        return { ok: false, reason: 'Saving signatures needs a protected system keyring.' };
      return { ok: true };
    },
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: async (data) => {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
      return { plain: result, rotate: shouldReEncrypt };
    },
  });
  handle('sign-store-load', z.undefined(), () => store.load());
  handle('sign-store-save', itemsSchema, (items) => store.save(items));
}
