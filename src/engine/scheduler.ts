/** Stable priority ordering; the worker only executes one MuPDF call at a time. */
export class PriorityQueue<T extends { id: number; priority: number }> {
  private items: T[] = [];

  push(item: T) {
    this.items.push(item);
    this.items.sort((a, b) => b.priority - a.priority || a.id - b.id);
  }

  shift(): T | undefined { return this.items.shift(); }
  get size() { return this.items.length; }
}
