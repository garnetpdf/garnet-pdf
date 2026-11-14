/** Bookmark tree editing. Pure functions shared by the Bookmarks panel, the engine and tests. */
export interface BookmarkNode {
  /** Existing outline item object number; absent for new bookmarks. */
  key?: number;
  /** Stable id within the panel session. */
  id: string;
  title: string;
  /** Destination page (zero-based) for display; new bookmarks also carry `pageId`. */
  pageIndex: number | null;
  pageId?: number;
  /** Vertical position on the page in MuPDF page space (top-left origin), for new bookmarks. */
  top?: number;
  uri?: string;
  open: boolean;
  children: BookmarkNode[];
}
export type DropPosition = 'before' | 'after' | 'inside';

export function cloneTree(nodes: BookmarkNode[]): BookmarkNode[] {
  return nodes.map(node => ({ ...node, children: cloneTree(node.children) }));
}

export function findNode(nodes: BookmarkNode[], id: string): { node: BookmarkNode; parent: BookmarkNode | null; siblings: BookmarkNode[]; index: number } | null {
  const walk = (list: BookmarkNode[], parent: BookmarkNode | null): ReturnType<typeof findNode> => {
    for (let index = 0; index < list.length; index++) {
      const node = list[index];
      if (node.id === id) return { node, parent, siblings: list, index };
      const inner = walk(node.children, node);
      if (inner) return inner;
    }
    return null;
  };
  return walk(nodes, null);
}

function contains(node: BookmarkNode, id: string): boolean {
  return node.id === id || node.children.some(child => contains(child, id));
}

/** Moves `id` relative to `targetId`. Returns a new tree, or null for an impossible move (into itself). */
export function moveNode(tree: BookmarkNode[], id: string, targetId: string, position: DropPosition): BookmarkNode[] | null {
  if (id === targetId) return null;
  const next = cloneTree(tree);
  const source = findNode(next, id);
  if (!source || contains(source.node, targetId)) return null;
  source.siblings.splice(source.index, 1);
  const target = findNode(next, targetId);
  if (!target) return null;
  if (position === 'inside') { target.node.children.push(source.node); target.node.open = true; }
  else target.siblings.splice(target.index + (position === 'after' ? 1 : 0), 0, source.node);
  return next;
}

export function removeNode(tree: BookmarkNode[], id: string): BookmarkNode[] {
  const next = cloneTree(tree);
  const found = findNode(next, id);
  if (found) found.siblings.splice(found.index, 1);
  return next;
}

export function renameNode(tree: BookmarkNode[], id: string, title: string): BookmarkNode[] {
  const next = cloneTree(tree);
  const found = findNode(next, id);
  if (found) found.node.title = title;
  return next;
}

/** Moves a node one step up or down among its siblings. */
export function shiftNode(tree: BookmarkNode[], id: string, delta: -1 | 1): BookmarkNode[] | null {
  const found = findNode(tree, id);
  if (!found) return null;
  const target = found.siblings[found.index + delta];
  return target ? moveNode(tree, id, target.id, delta < 0 ? 'before' : 'after') : null;
}

/** Nests a node under its previous sibling (indent) or moves it after its parent (outdent). */
export function indentNode(tree: BookmarkNode[], id: string, direction: 'in' | 'out'): BookmarkNode[] | null {
  const found = findNode(tree, id);
  if (!found) return null;
  if (direction === 'in') {
    const previous = found.siblings[found.index - 1];
    return previous ? moveNode(tree, id, previous.id, 'inside') : null;
  }
  return found.parent ? moveNode(tree, id, found.parent.id, 'after') : null;
}

/** Visible descendants when a node is open (ISO 32000 outline item /Count). */
export function visibleDescendants(node: Pick<BookmarkNode, 'open' | 'children'>): number {
  return node.children.reduce((sum, child) => sum + 1 + (child.open ? visibleDescendants(child) : 0), 0);
}

/** /Count for an outline item: positive when open, negative when closed, absent without children. */
export function itemCount(node: Pick<BookmarkNode, 'open' | 'children'>): number | null {
  if (!node.children.length) return null;
  const visible = visibleDescendants(node);
  return node.open ? visible : -visible;
}

/** /Count for the outline dictionary: all items visible at the top level and below open items. */
export function rootCount(nodes: Pick<BookmarkNode, 'open' | 'children'>[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.open ? visibleDescendants(node) : 0), 0);
}

export function flatten(nodes: BookmarkNode[], depth = 0, out: { node: BookmarkNode; depth: number }[] = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    flatten(node.children, depth + 1, out);
  }
  return out;
}
