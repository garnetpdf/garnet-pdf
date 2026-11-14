import { useEffect, useMemo, useRef, useState, useSyncExternalStore, memo } from 'react';
import type { LinkInfo, PageInfo, SearchHit, TextLine } from '../../shared/engine-api';
import type { Tab } from '../store';
import { useApp } from '../store';
import { engine, host, toast } from '../runtime';
import { cache } from './render-cache';
import { ContextMenu } from '../ui';
import type { MenuItem } from '../plugin-host/types';
import { EditOverlay } from '../plugin-host/EditOverlay';
import { inverse, viewMatrix, viewPointToPage, transformRect } from '../plugin-host/geometry';
export const CSS_DPI = 96 / 72;
let closing = false;
window.addEventListener('beforeunload', () => {
  closing = true;
});
export function PageView({
  tab,
  page,
  visible,
  viewport,
}: {
  tab: Tab;
  page: PageInfo;
  visible: boolean;
  viewport: { x: number; y: number; width: number; height: number };
}) {
  useSyncExternalStore(host.subscribe, host.snapshot);
  const activeTool = host.activeTool ? host.tools.get(host.activeTool) : undefined;
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const base = useRef<HTMLCanvasElement>(null),
    [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null),
    [lines, setLines] = useState<TextLine[]>([]),
    [links, setLinks] = useState<LinkInfo[]>([]),
    [tiles, setTiles] = useState<{ x: number; y: number; w: number; h: number; key: string }[]>([]),
    [painted, setPainted] = useState(false);
  const mode = useApp((s) => s.mode),
    hits = useApp((s) => s.hits),
    scale = tab.zoom * CSS_DPI,
    dpr = window.devicePixelRatio || 1;
  const { docId, revision } = tab.info;
  const keyBase = `${docId}:${revision}:${page.id}:${scale.toFixed(4)}:${dpr}:true:true`;
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let disposed = false;
    setPainted(false);
    const render = async (s: number) => {
      const key = `${docId}:${revision}:${page.id}:${s.toFixed(4)}:${dpr}:true:true:full`;
      let bitmap = cache.get(key);
      if (!bitmap) {
        const result = await engine.call(
          'core.render',
          { docId, pageId: page.id, scale: s, dpr, annots: true, forms: true },
          { signal: controller.signal, priority: s < scale ? 80 : 100 },
        );
        bitmap = result.bitmap;
        if (bitmap) cache.set(key, bitmap);
      }
      if (!disposed && bitmap && base.current) {
        const c = base.current;
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext('2d')?.drawImage(bitmap, 0, 0);
        setPainted(true);
        window.dispatchEvent(
          new CustomEvent('garnet:paint', { detail: { docId, pageId: page.id } }),
        );
      }
    };
    void (async () => {
      await render(Math.min(scale, 0.55));
      if (tab.zoom <= 2) await render(scale);
    })().catch((e) => {
      if (!controller.signal.aborted) toast(String(e));
    });
    void engine
      .call('core.text', { docId, pageId: page.id }, { signal: controller.signal, priority: 30 })
      .then((r) => {
        if (!disposed) setLines(r.lines);
      })
      .catch(() => {});
    void engine
      .call(
        'core.getLinks',
        { docId, pageId: page.id },
        { signal: controller.signal, priority: 20 },
      )
      .then((r) => {
        if (!disposed) setLinks(r);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [docId, revision, page.id, scale, dpr, visible, tab.zoom]);
  useEffect(() => {
    if (!visible || tab.zoom <= 2) {
      setTiles([]);
      return;
    }
    const visibleRect = transformRect(inverse(viewMatrix(page.width, page.height, tab.rotation)), [
      viewport.x / scale,
      viewport.y / scale,
      (viewport.x + viewport.width) / scale,
      (viewport.y + viewport.height) / scale,
    ]);
    const tileView = {
      x: Math.max(0, visibleRect[0] * scale),
      y: Math.max(0, visibleRect[1] * scale),
      width: (visibleRect[2] - visibleRect[0]) * scale,
      height: (visibleRect[3] - visibleRect[1]) * scale,
    };
    const size = 512 / dpr;
    const width = page.width * scale,
      height = page.height * scale;
    const result = [];
    const x0 = Math.max(0, Math.floor(tileView.x / size) * size),
      y0 = Math.max(0, Math.floor(tileView.y / size) * size);
    for (let y = y0; y < Math.min(height, tileView.y + tileView.height + size); y += size)
      for (let x = x0; x < Math.min(width, tileView.x + tileView.width + size); x += size)
        result.push({
          x,
          y,
          w: Math.min(size, width - x),
          h: Math.min(size, height - y),
          key: `${keyBase}:${x}:${y}`,
        });
    setTiles(result);
  }, [
    visible,
    tab.zoom,
    keyBase,
    page.width,
    page.height,
    scale,
    dpr,
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
  ]);
  const pageModel = useMemo(() => {
    const rotated = page.rotation % 180 !== 0;
    const width = rotated ? page.height : page.width,
      height = rotated ? page.width : page.height;
    const matrix = viewMatrix(width, height, page.rotation);
    return {
      docId,
      pageId: page.id,
      width,
      height,
      rotation: page.rotation,
      viewRotation: tab.rotation,
      pageToView: matrix,
      viewToPage: inverse(matrix),
    };
  }, [docId, page.id, page.width, page.height, page.rotation, tab.rotation]);
  return (
    <div
      className="page-inner"
      onContextMenu={(e) => {
        if (e.defaultPrevented) return;
        const items = [...(host.menus.get('page') || []), ...(host.menus.get('document') || [])];
        if (items.length) {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, items });
        }
      }}
      style={{
        width: page.width * scale,
        height: page.height * scale,
        transform: tab.rotation ? `rotate(${tab.rotation}deg)` : 'none',
        transformOrigin: 'center',
      }}
    >
      <canvas
        className="page-canvas"
        ref={(el) => {
          base.current = el;
          if (el !== canvas) setCanvas(el);
        }}
        data-testid="page-canvas"
        data-painted={painted}
        data-page={page.index + 1}
        style={{ width: page.width * scale, height: page.height * scale }}
      />
      {tiles.map((tile) => (
        <Tile key={tile.key} tile={tile} docId={docId} page={page} scale={scale} dpr={dpr} />
      ))}
      {!painted && <div className="page-loading">Loading page {page.index + 1}</div>}
      <div className="text-layer" style={{ pointerEvents: mode === 'Edit' ? 'none' : undefined }}>
        {lines.map((line, i) => (
          <span
            key={i}
            dir="auto"
            style={{
              left: line.bbox[0] * scale,
              top: line.bbox[1] * scale,
              width: (line.bbox[2] - line.bbox[0]) * scale,
              height: (line.bbox[3] - line.bbox[1]) * scale,
              fontSize: (line.chars[0]?.size || 12) * scale,
              lineHeight: `${(line.bbox[3] - line.bbox[1]) * scale}px`,
            }}
          >
            {line.text}
          </span>
        ))}
      </div>
      <div className="search-highlights">
        {hits
          .filter((h) => h.pageId === page.id)
          .flatMap((hit, i) =>
            hit.quads.map((q, j) => {
              const xs = [q[0], q[2], q[4], q[6]],
                ys = [q[1], q[3], q[5], q[7]];
              return (
                <mark
                  key={`${i}:${j}`}
                  data-testid="search-highlight"
                  style={{
                    left: Math.min(...xs) * scale,
                    top: Math.min(...ys) * scale,
                    width: (Math.max(...xs) - Math.min(...xs)) * scale,
                    height: (Math.max(...ys) - Math.min(...ys)) * scale,
                  }}
                />
              );
            }),
          )}
      </div>
      {links.map((link, i) => (
        <button
          key={i}
          className="pdf-link"
          aria-label={`Open link ${link.uri}`}
          title={link.uri}
          style={{
            left: link.bounds[0] * scale,
            top: link.bounds[1] * scale,
            width: (link.bounds[2] - link.bounds[0]) * scale,
            height: (link.bounds[3] - link.bounds[1]) * scale,
          }}
          onClick={() => {
            if (link.external) void window.garnet.openExternal(link.uri);
            else {
              const match = link.uri.match(/page=(\d+)/);
              if (match)
                useApp.getState().updateTab(docId, { page: Math.max(0, Number(match[1]) - 1) });
            }
          }}
        />
      ))}
      {activeTool && (
        <div
          className="tool-overlay"
          style={{ cursor: activeTool.cursor }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = e.currentTarget.getBoundingClientRect();
            activeTool.onPointerDown?.(
              pageModel,
              viewPointToPage(pageModel, [
                (e.clientX - r.left) / scale,
                (e.clientY - r.top) / scale,
              ]),
            );
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            activeTool.onPointerMove?.(
              pageModel,
              viewPointToPage(pageModel, [
                (e.clientX - r.left) / scale,
                (e.clientY - r.top) / scale,
              ]),
            );
          }}
          onPointerUp={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            activeTool.onPointerUp?.(
              pageModel,
              viewPointToPage(pageModel, [
                (e.clientX - r.left) / scale,
                (e.clientY - r.top) / scale,
              ]),
            );
          }}
        >
          {activeTool.overlay && <activeTool.overlay page={pageModel} />}
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.items.map((item) => (
            <button
              role="menuitem"
              key={item.id}
              onClick={() => {
                void item.run();
                setMenu(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </ContextMenu>
      )}
      {mode === 'Edit' && (
        <EditOverlay host={host} page={pageModel} scale={scale} canvas={canvas} />
      )}
    </div>
  );
}
function Tile({
  tile,
  docId,
  page,
  scale,
  dpr,
}: {
  tile: { x: number; y: number; w: number; h: number; key: string };
  docId: string;
  page: PageInfo;
  scale: number;
  dpr: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      let bitmap = cache.get(tile.key);
      if (!bitmap) {
        const r = await engine.call(
          'core.render',
          {
            docId,
            pageId: page.id,
            scale,
            dpr,
            rect: [
              tile.x / scale,
              tile.y / scale,
              (tile.x + tile.w) / scale,
              (tile.y + tile.h) / scale,
            ],
            annots: true,
            forms: true,
          },
          { signal: abort.signal, priority: 150 },
        );
        bitmap = r.bitmap;
        if (bitmap) cache.set(tile.key, bitmap);
      }
      if (bitmap && ref.current && !abort.signal.aborted) {
        ref.current.width = bitmap.width;
        ref.current.height = bitmap.height;
        ref.current.getContext('2d')?.drawImage(bitmap, 0, 0);
        ref.current.dataset.painted = 'true';
      }
    })().catch((e) => {
      if (!abort.signal.aborted) toast(String(e));
    });
    return () => abort.abort();
  }, [tile.key, docId, page.id, scale, dpr, tile.x, tile.y, tile.w, tile.h]);
  return (
    <canvas
      ref={ref}
      data-testid="render-tile"
      className="render-tile"
      style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
    />
  );
}
function ThumbnailView({
  tab,
  page,
  onClick,
  active,
}: {
  tab: Tab;
  page: PageInfo;
  onClick: () => void;
  active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void engine
          .call(
            'core.render',
            {
              docId: tab.info.docId,
              pageId: page.id,
              scale: 0.18,
              dpr: 1,
              annots: true,
              forms: true,
            },
            { signal: abort.signal, priority: 1 },
          )
          .then((r) => {
            if (r.bitmap && canvas.current && !abort.signal.aborted) {
              const c = canvas.current;
              c.width = r.width;
              c.height = r.height;
              c.getContext('2d')?.drawImage(r.bitmap, 0, 0);
              r.bitmap.close();
              c.dataset.revision = String(tab.info.revision);
              if (page.index === 0 && tab.file.handle)
                void new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
                  .then(async (b) => {
                    if (!b || abort.signal.aborted || closing) return;
                    const bytes = await b.arrayBuffer();
                    if (!abort.signal.aborted && !closing)
                      await window.garnet.recent.setThumbnail(tab.file.handle, bytes);
                  })
                  .catch(() => {});
            }
          })
          .catch(() => {});
      },
      { rootMargin: '150px' },
    );
    if (button.current) observer.observe(button.current);
    return () => {
      observer.disconnect();
      abort.abort();
    };
  }, [tab.info.docId, tab.info.revision, page.id, tab.file.handle, page.index]);
  useEffect(() => {
    if (active) button.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={button}
      className={`thumbnail ${active ? 'active' : ''}`}
      onClick={onClick}
      aria-label={`Page ${page.index + 1}`}
      aria-current={active ? 'page' : undefined}
    >
      <canvas ref={canvas} style={{ aspectRatio: `${page.width}/${page.height}` }} />
      <span>{page.label || page.index + 1}</span>
    </button>
  );
}
export const Thumbnail = memo(
  ThumbnailView,
  (a, b) =>
    a.page === b.page &&
    a.active === b.active &&
    a.tab.info === b.tab.info &&
    a.tab.file.handle === b.tab.file.handle,
);
export function hitLabel(hit: SearchHit) {
  return `Page ${hit.pageIndex + 1}`;
}
