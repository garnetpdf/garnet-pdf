import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { saveAtomically } from './atomic-save';

const CAP = 500 * 1024 * 1024;

export class BackupStore {
  constructor(private readonly folder: string) {}
  async retainPrevious(path: string): Promise<void> {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await mkdir(this.folder, { recursive: true });
    const prefix = createHash('sha256').update(path).digest('hex').slice(0, 32);
    const name = `${prefix}-${Date.now()}-${randomUUID()}.pdf`;
    await saveAtomically(join(this.folder, name), data, (candidate) => {
      if (
        createHash('sha256').update(candidate).digest('hex') !==
        createHash('sha256').update(data).digest('hex')
      )
        throw new Error('Backup verification failed.');
    });
    await this.prune(prefix);
  }
  async purge(path: string): Promise<void> {
    const prefix = createHash('sha256').update(path).digest('hex').slice(0, 32);
    const names = await readdir(this.folder).catch(() => []);
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${prefix}-`))
        .map((name) => unlink(join(this.folder, name))),
    );
  }
  private async prune(prefix: string): Promise<void> {
    const names = await readdir(this.folder);
    const rows = await Promise.all(
      names
        .filter((name) => name.endsWith('.pdf'))
        .map(async (name) => {
          const info = await stat(join(this.folder, name));
          return { name, size: info.size, time: info.mtimeMs };
        }),
    );
    const own = rows
      .filter((row) => row.name.startsWith(`${prefix}-`))
      .sort((a, b) => b.time - a.time);
    const remove = new Set(own.slice(3).map((row) => row.name));
    let bytes = rows.filter((row) => !remove.has(row.name)).reduce((sum, row) => sum + row.size, 0);
    for (const row of rows.filter((row) => !remove.has(row.name)).sort((a, b) => a.time - b.time)) {
      if (bytes <= CAP) break;
      bytes -= row.size;
      remove.add(row.name);
    }
    await Promise.all([...remove].map((name) => unlink(join(this.folder, name))));
  }
}
