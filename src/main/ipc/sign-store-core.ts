/**
 * Encrypted store for saved signatures, initials and image stamps. The whole list is one file
 * encrypted with the operating system's protection (Electron safeStorage: DPAPI on Windows,
 * Keychain on macOS, the keyring on Linux), written atomically. No plain JSON ever touches disk.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { saveAtomically } from '../atomic-save';
import type { SignStoreState, StoredSignItem } from './sign-store-bridge';

export const MAX_ITEMS = 60;
export const MAX_PNG_BASE64 = 4_000_000;

export const itemSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    kind: z.enum(['signature', 'initials', 'stamp']),
    name: z.string().max(120),
    png: z
      .string()
      .min(16)
      .max(MAX_PNG_BASE64)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((value) => value.startsWith('iVBORw0KGgo'), 'Only PNG images are stored.'),
    width: z.number().int().min(1).max(8000),
    height: z.number().int().min(1).max(8000),
    created: z.number().finite().nonnegative(),
  })
  .strict();
export const itemsSchema = z.array(itemSchema).max(MAX_ITEMS);

export interface StoreCrypto {
  availability(): Promise<{ ok: boolean; reason?: string }>;
  encrypt(plain: string): Promise<Buffer>;
  /** `rotate` is true when the system asks for the data to be encrypted again with a newer key. */
  decrypt(data: Buffer): Promise<{ plain: string; rotate?: boolean }>;
}

export function createSignStore(path: string, crypto: StoreCrypto) {
  const decode = async (data: Uint8Array): Promise<{ items: StoredSignItem[]; rotate: boolean }> => {
    const { plain, rotate } = await crypto.decrypt(Buffer.from(data));
    const parsed = JSON.parse(plain) as { version?: number; items?: unknown };
    if (parsed.version !== 1) throw new Error('Unknown saved signature format.');
    return { items: itemsSchema.parse(parsed.items), rotate: !!rotate };
  };
  const store = {
    async load(): Promise<SignStoreState> {
      const availability = await crypto.availability();
      if (!availability.ok) return { available: false, reason: availability.reason, items: [] };
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: true, items: [] };
        return { available: true, reason: 'Saved signatures could not be read.', items: [] };
      }
      try {
        const { items, rotate } = await decode(data);
        if (rotate) await store.save(items).catch(() => undefined);
        return { available: true, items };
      } catch {
        return { available: true, reason: 'Saved signatures could not be decrypted on this account.', items: [] };
      }
    },
    async save(items: StoredSignItem[]): Promise<{ saved: boolean; reason?: string }> {
      const availability = await crypto.availability();
      if (!availability.ok) return { saved: false, reason: availability.reason };
      const valid = itemsSchema.parse(items);
      const plain = JSON.stringify({ version: 1, items: valid });
      const encrypted = await crypto.encrypt(plain);
      await mkdir(dirname(path), { recursive: true });
      await saveAtomically(path, new Uint8Array(encrypted), async (candidate) => {
        if (JSON.stringify((await decode(candidate)).items) !== JSON.stringify(valid))
          throw new Error('Encrypted signature store did not verify.');
      });
      return { saved: true };
    },
  };
  return store;
}
