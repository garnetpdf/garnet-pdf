import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  IndentDecrease,
  IndentIncrease,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { PluginContext } from '../../plugin-host/types';
import { useApp } from '../../store';
import { EmptyState, IconButton } from '../../ui';
import {
  cloneTree,
  findNode,
  flatten,
  indentNode,
  moveNode,
  removeNode,
  renameNode,
  shiftNode,
  type BookmarkNode,
  type DropPosition,
} from '../../../engine/tools/panels/outline-tree';
import { errorText, tabFor, useRevision } from '../protect/kit';

const NEW_ID = 'new-bookmark';

/** Where the visible area starts on a page, in MuPDF page space, so a new bookmark opens at the current view. */
function viewTop(docId: string, pageIndex: number): number {
  const tab = tabFor(docId);
  const page = tab?.info.pages[pageIndex];
  const element = document.querySelector<HTMLElement>(`[data-page-number="${pageIndex + 1}"]`);
  const viewport = document.querySelector('.viewer-container');
  if (!tab || !page || !element || !viewport || tab.rotation) return 0;
  const box = element.getBoundingClientRect();
  const offset = viewport.getBoundingClientRect().top - box.top;
  if (offset <= 0 || !box.height) return 0;
  return Math.round(Math.min(page.height, (offset / box.height) * page.height));
}

function dropPosition(event: { clientY: number; currentTarget: Element }): DropPosition {
  const box = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - box.top) / box.height;
  return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
}

export function BookmarksPanel({ ctx }: { ctx: PluginContext }) {
  const docId = useApp((state) => state.activeId) ?? undefined;
  const revision = useRevision(docId);
  const [tree, setTree] = useState<BookmarkNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [draft, setDraft] = useState<BookmarkNode[] | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: DropPosition } | null>(null);
  const dragged = useRef<string | null>(null);
  const loadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!docId) return;
    let live = true;
    ctx.engine
      .call('outline.get', { docId })
      .then((next) => {
        if (!live) return;
        if (loadedFor.current !== docId) {
          loadedFor.current = docId;
          setExpanded(
            new Set(
              flatten(next)
                .filter(({ node }) => node.open)
                .map(({ node }) => node.id),
            ),
          );
        }
        setTree(next);
        setDraft(null);
      })
      .catch((error) => ctx.ui.toast(errorText(error)));
    return () => {
      live = false;
    };
  }, [docId, revision]);
  if (!docId) return null;
  const shown = draft ?? tree;
  const commit = async (next: BookmarkNode[] | null, label: string) => {
    if (!next) return;
    try {
      await ctx.engine.call('outline.set', { docId, tree: next, label });
    } catch (error) {
      ctx.ui.toast(errorText(error));
      setDraft(null);
    }
  };
  const selectedNode = selected ? findNode(shown, selected) : null;
  const add = () => {
    const tab = tabFor(docId);
    if (!tab) return;
    const page = tab.info.pages[tab.page];
    const node: BookmarkNode = {
      id: NEW_ID,
      title: `Page ${page.label || page.index + 1}`,
      pageIndex: page.index,
      pageId: page.id,
      top: viewTop(docId, page.index),
      open: false,
      children: [],
    };
    const next = cloneTree(tree);
    const place = selected ? findNode(next, selected) : null;
    if (place) place.siblings.splice(place.index + 1, 0, node);
    else next.push(node);
    setDraft(next);
    setSelected(NEW_ID);
    setEditing({ id: NEW_ID, title: node.title });
  };
  const finishEdit = (save: boolean) => {
    if (!editing) return;
    const { id, title } = editing;
    setEditing(null);
    const clean = title.trim();
    if (id === NEW_ID) {
      if (!save || !draft) return setDraft(null);
      void commit(renameNode(draft, NEW_ID, clean || 'Untitled bookmark'), 'Add bookmark');
      return;
    }
    const current = findNode(tree, id)?.node;
    if (save && clean && current && clean !== current.title)
      void commit(renameNode(tree, id, clean), 'Rename bookmark');
  };
  const remove = async () => {
    if (!selectedNode) return;
    const nested = flatten(selectedNode.node.children).length;
    if (
      nested &&
      !(await ctx.ui.confirm(
        `Delete "${selectedNode.node.title}" and the ${nested} bookmarks inside it?`,
      ))
    )
      return;
    setSelected(null);
    void commit(removeNode(tree, selectedNode.node.id), 'Delete bookmark');
  };
  const go = (node: BookmarkNode) => {
    setSelected(node.id);
    if (node.pageIndex !== null) useApp.getState().updateTab(docId, { page: node.pageIndex });
  };
  const onKey = (event: ReactKeyboardEvent, node: BookmarkNode) => {
    if (editing) return;
    if (event.key === 'F2') setEditing({ id: node.id, title: node.title });
    else if (event.key === 'Delete') void remove();
    else if (event.key === 'Enter') go(node);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const rows: { node: BookmarkNode; depth: number }[] = [];
  const walk = (nodes: BookmarkNode[], depth: number) =>
    nodes.forEach((node) => {
      rows.push({ node, depth });
      if (expanded.has(node.id)) walk(node.children, depth + 1);
    });
  walk(shown, 0);
  const disabled = !selectedNode || !!editing || selected === NEW_ID;
  return (
    <div className="p4b-panel" data-testid="bookmarks-panel">
      <div className="p4b-panel-toolbar" role="toolbar" aria-label="Bookmark actions">
        <IconButton label="Add bookmark for the current page" onClick={add} disabled={!!editing}>
          <BookmarkPlus size={15} />
        </IconButton>
        <IconButton
          label="Rename bookmark"
          disabled={disabled}
          onClick={() =>
            selectedNode && setEditing({ id: selectedNode.node.id, title: selectedNode.node.title })
          }
        >
          <Pencil size={15} />
        </IconButton>
        <IconButton label="Delete bookmark" disabled={disabled} onClick={() => void remove()}>
          <Trash2 size={15} />
        </IconButton>
        <span className="p4b-spacer" />
        <IconButton
          label="Move up"
          disabled={disabled}
          onClick={() => selected && void commit(shiftNode(tree, selected, -1), 'Move bookmark')}
        >
          <ArrowUp size={15} />
        </IconButton>
        <IconButton
          label="Move down"
          disabled={disabled}
          onClick={() => selected && void commit(shiftNode(tree, selected, 1), 'Move bookmark')}
        >
          <ArrowDown size={15} />
        </IconButton>
        <IconButton
          label="Move out one level"
          disabled={disabled}
          onClick={() =>
            selected && void commit(indentNode(tree, selected, 'out'), 'Move bookmark')
          }
        >
          <IndentDecrease size={15} />
        </IconButton>
        <IconButton
          label="Move in one level"
          disabled={disabled}
          onClick={() => selected && void commit(indentNode(tree, selected, 'in'), 'Move bookmark')}
        >
          <IndentIncrease size={15} />
        </IconButton>
      </div>
      {!rows.length ? (
        <EmptyState>No bookmarks yet. Choose Add bookmark to mark the current page.</EmptyState>
      ) : (
        <div className="p4b-panel-body" role="tree" aria-label="Bookmarks">
          {rows.map(({ node, depth }) => {
            const open = expanded.has(node.id);
            const isEditing = editing?.id === node.id;
            return (
              <div
                key={node.id}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={selected === node.id}
                aria-expanded={node.children.length ? open : undefined}
                tabIndex={selected === node.id || (!selected && rows[0].node === node) ? 0 : -1}
                className={`p4b-tree-row ${drop?.id === node.id ? `drop-${drop.position}` : ''}`}
                style={{ paddingInlineStart: depth * 16 }}
                draggable={!isEditing && node.id !== NEW_ID}
                onClick={() => !isEditing && go(node)}
                onDoubleClick={() =>
                  node.id !== NEW_ID && setEditing({ id: node.id, title: node.title })
                }
                onKeyDown={(event) => onKey(event, node)}
                onDragStart={(event) => {
                  dragged.current = node.id;
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', node.title);
                }}
                onDragOver={(event) => {
                  if (!dragged.current || dragged.current === node.id) return;
                  event.preventDefault();
                  const position = dropPosition(event);
                  if (drop?.id !== node.id || drop.position !== position)
                    setDrop({ id: node.id, position });
                }}
                onDragLeave={() => setDrop((current) => (current?.id === node.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const source = dragged.current;
                  const position = dropPosition(event);
                  dragged.current = null;
                  setDrop(null);
                  if (source && source !== node.id) {
                    if (position === 'inside') setExpanded(new Set([...expanded, node.id]));
                    void commit(moveNode(tree, source, node.id, position), 'Move bookmark');
                  }
                }}
                onDragEnd={() => {
                  dragged.current = null;
                  setDrop(null);
                }}
              >
                {node.children.length ? (
                  <button
                    type="button"
                    className="p4b-twisty"
                    aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      const next = new Set(expanded);
                      if (open) next.delete(node.id);
                      else next.add(node.id);
                      setExpanded(next);
                    }}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <span className="p4b-twisty" />
                )}
                {isEditing ? (
                  <input
                    aria-label="Bookmark title"
                    autoFocus
                    value={editing.title}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setEditing({ id: node.id, title: event.target.value })}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') finishEdit(true);
                      if (event.key === 'Escape') finishEdit(false);
                    }}
                    onBlur={() => finishEdit(true)}
                  />
                ) : (
                  <span className="p4b-title" title={node.title}>
                    {node.title || 'Untitled bookmark'}
                  </span>
                )}
                {node.pageIndex !== null && !isEditing && (
                  <span className="p4b-page-tag">{node.pageIndex + 1}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
