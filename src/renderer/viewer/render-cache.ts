/** LRU owns every bitmap and closes it on eviction. Entries never cross documents or revisions. */
export class BitmapCache {
  private entries = new Map<string, ImageBitmap>();
  private bytes = 0;
  constructor(readonly maxBytes = 96 * 1024 * 1024) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: ImageBitmap) {
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.width * old.height * 4;
      old.close();
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.width * value.height * 4;
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const [first, b] = this.entries.entries().next().value!;
      this.entries.delete(first);
      this.bytes -= b.width * b.height * 4;
      b.close();
    }
  }
  clear() {
    this.entries.forEach((b) => b.close());
    this.entries.clear();
    this.bytes = 0;
  }
  get size() {
    return this.entries.size;
  }
}
export const cache = new BitmapCache();
