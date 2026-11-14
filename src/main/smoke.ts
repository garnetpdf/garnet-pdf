import { app } from 'electron';
import { release } from 'node:os';
import type { FileStore } from './file-store';

/** Result of one storage check: true, or the reason it could not be done. */
type Outcome = boolean | string;

export interface SmokeEnvironment {
  version: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  /** The processor the app is running as (x64 on an Intel Mac, arm64 on Apple silicon). */
  arch: string;
  /** True when an Intel build runs on Apple silicon through Rosetta. */
  translated: boolean;
  osRelease: string;
  electron: string;
  chrome: string;
  /** True when Windows runs the app from a Store (MSIX) package. */
  windowsStore: boolean;
  /** Where settings, recent files and recovery copies are kept. */
  userData: string;
  storage: { settings: Outcome; recovery: Outcome; encryptedRecovery: Outcome };
}

/**
 * Writes the settings file and a recovery copy (plain, then encrypted with the key kept by the
 * system: Keychain on a Mac, DPAPI on Windows), reads each back and removes it again. This shows
 * that the app's own data folder works in the place the system gives it, for example inside a
 * Store package. On a system with no protected key store the encrypted check reports the reason.
 */
export async function checkStorage(store: FileStore): Promise<SmokeEnvironment['storage']> {
  const reason = (error: unknown): string => String((error as Error)?.message ?? error);
  let settings: Outcome;
  try {
    await store.setSettings(await store.settings());
    settings = true;
  } catch (error) {
    settings = reason(error);
  }
  const sample = Buffer.from('%PDF-1.7\n% Garnet PDF storage check\n');
  const roundTrip = async (id: string, encrypted: boolean): Promise<Outcome> => {
    try {
      const bytes = sample.buffer.slice(
        sample.byteOffset,
        sample.byteOffset + sample.byteLength,
      ) as ArrayBuffer;
      await store.writeRecovery(id, 'storage-check.pdf', undefined, bytes, 1, encrypted);
      return Buffer.from(await store.readRecovery(id)).equals(sample);
    } catch (error) {
      return reason(error);
    } finally {
      await store.deleteRecovery(id).catch(() => undefined);
    }
  };
  return {
    settings,
    recovery: await roundTrip('storage-check', false),
    encryptedRecovery: await roundTrip('storage-check-encrypted', true),
  };
}

/** Facts about the running app, written next to the results of the smoke test. */
export async function smokeEnvironment(store: FileStore): Promise<SmokeEnvironment> {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    translated: app.runningUnderARM64Translation,
    osRelease: release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    windowsStore: Boolean(process.windowsStore),
    userData: app.getPath('userData'),
    storage: await checkStorage(store),
  };
}
