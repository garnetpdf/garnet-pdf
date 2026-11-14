import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, stat, mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type {
  FileDescriptor,
  RecentFile,
  RecentViewState,
  RecoveryEntry,
  GarnetSettings,
} from '../shared/ipc';
import { saveAtomically } from './atomic-save';
import { safeStorage } from 'electron';

type DiskRecent = {
  path: string;
  lastOpened: number;
  thumbnail?: string;
  viewState?: RecentViewState;
};
export type FileFingerprint = { size: number; mtimeMs: number; sha256: string } | null;
type RecoveryVersion = {
  fileName: string;
  createdAt: number;
  revision: number;
  checksum: string;
  encrypted: boolean;
};
type DiskRecovery = {
  version: 2;
  id: string;
  name: string;
  originalPath?: string;
  snapshots: RecoveryVersion[];
};
type OldDiskRecovery = {
  version: 1;
  id: string;
  name: string;
  originalPath?: string;
} & RecoveryVersion;
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const defaults: GarnetSettings = {
  theme: 'light',
  defaultZoom: 'fit-width',
  authorName: '',
  enableJavaScript: false,
  recoveryIntervalSeconds: 60,
};

const kindOf = (path: string): 'pdf' | 'image' | null => {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'].includes(ext)) return 'image';
  return null;
};

export class FileStore {
  private paths = new Map<string, { path: string; ownerId: number }>();
  private reverse = new Map<string, string>();
  private fingerprints = new Map<string, Exclude<FileFingerprint, null>>();
  private recoveryQueues = new Map<string, Promise<unknown>>();
  private ownerId = 0;
  constructor(private readonly userData: string) {}

  setOwner(ownerId: number): void {
    if (this.ownerId === ownerId) return;
    this.ownerId = ownerId;
    this.paths.clear();
    this.reverse.clear();
    this.fingerprints.clear();
  }

  private async readJSON<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.userData, name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
  private async writeJSON(name: string, data: unknown): Promise<void> {
    await mkdir(this.userData, { recursive: true });
    const bytes = Buffer.from(JSON.stringify(data, null, 2));
    await saveAtomically(join(this.userData, name), bytes, (candidate) => {
      JSON.parse(Buffer.from(candidate).toString());
    });
  }
  private remember(path: string): string {
    path = resolve(path);
    const existing = this.reverse.get(path);
    if (existing) return existing;
    const handle = randomUUID();
    this.paths.set(handle, { path, ownerId: this.ownerId });
    this.reverse.set(path, handle);
    return handle;
  }
  path(handle: string): string {
    const entry = this.paths.get(handle);
    if (!entry || entry.ownerId !== this.ownerId)
      throw new Error('This file is no longer available. Open it again.');
    return entry.path;
  }
  async descriptor(path: string): Promise<FileDescriptor> {
    const kind = kindOf(path);
    if (!kind) throw new Error('Choose a PDF or supported image file.');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Choose a file.');
    return {
      handle: this.remember(path),
      name: basename(path),
      kind,
      size: info.size,
      lastModified: info.mtimeMs,
    };
  }
  async bytes(handle: string): Promise<ArrayBuffer> {
    const path = this.path(handle);
    const data = await readFile(path);
    const info = await stat(path);
    this.fingerprints.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(data) });
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  async changedSinceOpen(handle: string): Promise<boolean> {
    const path = this.path(handle);
    const baseline = this.fingerprints.get(path);
    if (!baseline) return false;
    return !FileStore.sameFingerprint(baseline, await this.fingerprintAtPath(path));
  }
  async fingerprintAtPath(path: string): Promise<FileFingerprint> {
    try {
      const info = await stat(path);
      const data = await readFile(path);
      return { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(data) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  static sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
    return a?.size === b?.size && a?.mtimeMs === b?.mtimeMs && a?.sha256 === b?.sha256;
  }
  async refreshFingerprint(handle: string): Promise<void> {
    await this.bytes(handle);
  }
  async recent(): Promise<RecentFile[]> {
    const stored = await this.readJSON<DiskRecent[]>('recent.json', []);
    const rows: RecentFile[] = [];
    for (const item of stored) {
      try {
        const descriptor = await this.descriptor(item.path);
        let thumbnail: string | undefined;
        if (item.thumbnail) {
          try {
            thumbnail = `data:image/png;base64,${(await readFile(join(this.userData, 'thumbnails', item.thumbnail))).toString('base64')}`;
          } catch {
            /* Thumbnail cache can be regenerated. */
          }
        }
        rows.push({
          ...descriptor,
          lastOpened: item.lastOpened,
          thumbnail,
          viewState: item.viewState,
        });
      } catch {
        /* Missing files are omitted from the visible list. */
      }
    }
    return rows;
  }
  async touchRecent(handle: string): Promise<void> {
    const path = this.path(handle);
    const rows = await this.readJSON<DiskRecent[]>('recent.json', []);
    const previous = rows.find((row) => row.path === path);
    await this.writeJSON(
      'recent.json',
      [
        {
          path,
          lastOpened: Date.now(),
          thumbnail: previous?.thumbnail,
          viewState: previous?.viewState,
        },
        ...rows.filter((row) => row.path !== path),
      ].slice(0, 24),
    );
  }
  async setThumbnail(handle: string, png: ArrayBuffer): Promise<void> {
    if (png.byteLength > 2_000_000) throw new Error('Thumbnail is too large.');
    const path = this.path(handle);
    const name = `${handle}.png`;
    const folder = join(this.userData, 'thumbnails');
    await mkdir(folder, { recursive: true });
    await saveAtomically(join(folder, name), new Uint8Array(png), (data) => {
      if (
        data.length < 8 ||
        !Buffer.from(data.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('Invalid PNG thumbnail.');
    });
    const rows = await this.readJSON<DiskRecent[]>('recent.json', []);
    const row = rows.find((item) => item.path === path);
    if (row) {
      row.thumbnail = name;
      await this.writeJSON('recent.json', rows);
    }
  }
  async setView(handle: string, viewState: RecentViewState): Promise<void> {
    const path = this.path(handle);
    const rows = await this.readJSON<DiskRecent[]>('recent.json', []);
    const row = rows.find((item) => item.path === path);
    if (row) row.viewState = viewState;
    else rows.unshift({ path, lastOpened: Date.now(), viewState });
    await this.writeJSON('recent.json', rows.slice(0, 24));
  }
  async removeRecent(handle: string): Promise<void> {
    const path = this.path(handle);
    const rows = await this.readJSON<DiskRecent[]>('recent.json', []);
    const removed = rows.find((item) => item.path === path);
    await this.writeJSON(
      'recent.json',
      rows.filter((item) => item.path !== path),
    );
    if (removed?.thumbnail)
      await unlink(join(this.userData, 'thumbnails', removed.thumbnail)).catch(() => undefined);
  }
  async settings(): Promise<GarnetSettings> {
    const saved = await this.readJSON<Partial<GarnetSettings>>('settings.json', {});
    return { ...defaults, ...saved };
  }
  async setSettings(patch: Partial<GarnetSettings>): Promise<GarnetSettings> {
    const next = { ...(await this.settings()), ...patch };
    if (!['light', 'dark', 'system'].includes(next.theme)) throw new Error('Invalid theme.');
    if (
      !Number.isFinite(next.recoveryIntervalSeconds) ||
      next.recoveryIntervalSeconds < 15 ||
      next.recoveryIntervalSeconds > 3600
    )
      throw new Error('Recovery interval must be between 15 and 3600 seconds.');
    next.enableJavaScript = Boolean(next.enableJavaScript);
    await this.writeJSON('settings.json', next);
    return next;
  }
  private recoveryDir(): string {
    return join(this.userData, 'recovery');
  }
  private async recoveryKey(): Promise<Buffer> {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Secure recovery is unavailable on this device.');
    if (
      process.platform === 'linux' &&
      ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())
    )
      throw new Error('Secure recovery requires a protected Linux keyring.');
    const path = join(this.recoveryDir(), 'key.bin');
    try {
      return Buffer.from(safeStorage.decryptString(await readFile(path)), 'base64');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Recovery encryption key could not be read.', { cause: error });
      const key = randomBytes(32);
      await mkdir(this.recoveryDir(), { recursive: true });
      await saveAtomically(
        path,
        safeStorage.encryptString(key.toString('base64')),
        () => undefined,
      );
      return key;
    }
  }
  private validId(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid recovery ID.');
  }
  private validSnapshotName(id: string, name: string): boolean {
    return name === basename(name) && name.startsWith(`${id}-`) && name.endsWith('.pdf');
  }
  private async manifest(id: string): Promise<DiskRecovery | null> {
    this.validId(id);
    const raw = await this.readJSON<DiskRecovery | OldDiskRecovery | null>(
      join('recovery', `${id}.json`),
      null,
    );
    if (!raw || raw.id !== id) return null;
    if (raw.version === 1) {
      const { fileName, createdAt, revision, checksum, encrypted } = raw;
      return {
        version: 2,
        id,
        name: raw.name,
        originalPath: raw.originalPath,
        snapshots: this.validSnapshotName(id, fileName)
          ? [{ fileName, createdAt, revision, checksum, encrypted }]
          : [],
      };
    }
    if (raw.version !== 2 || !Array.isArray(raw.snapshots)) return null;
    return {
      ...raw,
      snapshots: raw.snapshots.filter(
        (v) =>
          typeof v.fileName === 'string' &&
          this.validSnapshotName(id, v.fileName) &&
          Number.isInteger(v.revision) &&
          typeof v.checksum === 'string',
      ),
    };
  }
  private async latestValid(
    meta: DiskRecovery,
  ): Promise<{ version: RecoveryVersion; bytes: Buffer } | null> {
    const ordered = [...meta.snapshots].sort(
      (a, b) => b.revision - a.revision || b.createdAt - a.createdAt,
    );
    for (const version of ordered) {
      try {
        const bytes = await readFile(join(this.recoveryDir(), version.fileName));
        if (sha256(bytes) === version.checksum) return { version, bytes };
      } catch {
        /* Try the previous intact version. */
      }
    }
    return null;
  }
  private async queueRecovery<T>(id: string, job: () => Promise<T>): Promise<T> {
    const prior = this.recoveryQueues.get(id) || Promise.resolve();
    const current = prior.catch(() => undefined).then(job);
    this.recoveryQueues.set(id, current);
    try {
      return await current;
    } finally {
      if (this.recoveryQueues.get(id) === current) this.recoveryQueues.delete(id);
    }
  }
  async recoveryEntries(): Promise<RecoveryEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.recoveryDir());
    } catch {
      return [];
    }
    const rows: RecoveryEntry[] = [];
    for (const name of names.filter((name) => name.endsWith('.json'))) {
      const id = name.slice(0, -5);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) continue;
      const meta = await this.manifest(id);
      if (!meta) continue;
      try {
        const latest = await this.latestValid(meta);
        if (!latest) continue;
        const originalHandle = meta.originalPath ? this.remember(meta.originalPath) : undefined;
        rows.push({
          id,
          name: meta.name,
          originalHandle,
          createdAt: latest.version.createdAt,
          revision: latest.version.revision,
          encrypted: latest.version.encrypted,
        });
      } catch {
        /* Ignore incomplete snapshots. */
      }
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }
  async writeRecovery(
    id: string,
    name: string,
    originalHandle: string | undefined,
    bytes: ArrayBuffer,
    revision = 0,
    encrypted = false,
  ): Promise<void> {
    this.validId(id);
    await this.queueRecovery(id, () =>
      this.writeRecoveryVersion(id, name, originalHandle, bytes, revision, encrypted),
    );
  }
  private async writeRecoveryVersion(
    id: string,
    name: string,
    originalHandle: string | undefined,
    bytes: ArrayBuffer,
    revision: number,
    encrypted: boolean,
  ): Promise<void> {
    const previous = await this.manifest(id);
    if (previous?.snapshots.some((v) => v.revision > revision)) return;
    const originalPath = originalHandle ? this.path(originalHandle) : undefined;
    await mkdir(this.recoveryDir(), { recursive: true });
    const source = Buffer.from(bytes);
    if (!source.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('Invalid recovery PDF.');
    let stored = source;
    if (encrypted) {
      const key = await this.recoveryKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      stored = Buffer.concat([iv, cipher.update(source), cipher.final(), cipher.getAuthTag()]);
    }
    const fileName = `${id}-${revision}-${randomUUID()}.pdf`;
    await saveAtomically(join(this.recoveryDir(), fileName), stored, (data) => {
      if (sha256(data) !== sha256(stored)) throw new Error('Recovery checksum mismatch.');
      if (encrypted) return;
      if (data.length < 8 || !Buffer.from(data.slice(0, 5)).equals(Buffer.from('%PDF-')))
        throw new Error('Invalid recovery PDF.');
    });
    await this.writeJSON(join('recovery', `${id}.json`), {
      version: 2,
      id,
      name,
      originalPath,
      snapshots: [
        ...(previous?.snapshots || []),
        { fileName, createdAt: Date.now(), revision, checksum: sha256(stored), encrypted },
      ],
    } satisfies DiskRecovery);
  }
  async readRecovery(id: string): Promise<ArrayBuffer> {
    this.validId(id);
    const meta = await this.manifest(id);
    if (!meta) throw new Error('Recovery snapshot is unavailable.');
    const latest = await this.latestValid(meta);
    if (!latest) throw new Error('Recovery snapshot failed its checksum check.');
    let data = latest.bytes;
    if (latest.version.encrypted) {
      const key = await this.recoveryKey();
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(-16));
      data = Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
    }
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  async deleteRecovery(id: string): Promise<void> {
    this.validId(id);
    await this.queueRecovery(id, () => this.deleteRecoveryAll(id));
  }
  private async deleteRecoveryAll(id: string): Promise<void> {
    const meta = await this.manifest(id);
    await unlink(join(this.recoveryDir(), `${id}.json`)).catch(() => undefined);
    if (meta)
      await Promise.all(
        meta.snapshots.map((v) =>
          unlink(join(this.recoveryDir(), v.fileName)).catch(() => undefined),
        ),
      );
  }
  async deleteRecoveryUpTo(id: string, revision: number): Promise<void> {
    this.validId(id);
    await this.queueRecovery(id, async () => {
      const meta = await this.manifest(id);
      if (!meta) return;
      const retired = meta.snapshots.filter((v) => v.revision <= revision);
      const retained = meta.snapshots.filter((v) => v.revision > revision);
      if (!retired.length) return;
      if (retained.length)
        await this.writeJSON(join('recovery', `${id}.json`), {
          ...meta,
          snapshots: retained,
        } satisfies DiskRecovery);
      else await unlink(join(this.recoveryDir(), `${id}.json`));
      await Promise.all(
        retired.map((v) => unlink(join(this.recoveryDir(), v.fileName)).catch(() => undefined)),
      );
    });
  }
}
