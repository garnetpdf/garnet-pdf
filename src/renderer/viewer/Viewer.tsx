import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Tab } from '../store';
import { useApp } from '../store';
import { PageView, CSS_DPI } from './PageView';
import { MAX_ZOOM, MIN_ZOOM, stepZoom } from '../zoom';
interface Row {
  top: number;
  height: number;
  pages: { index: number; left: number; width: number; height: number }[];
  width: number;
}
/** The page under a point of the scrolled content, and where in that page the point lies (0 to 1 inside it). */
function locate(rows: Row[], contentWidth: number, x: number, y: number) {
  if (!rows.length) return null;
  const row = rows.find((r) => y < r.top + r.height + 12) ?? rows[rows.length - 1];
  const rowLeft = (contentWidth - row.width) / 2;
  const item =
    row.pages.find((p) => x < rowLeft + p.left + p.width + 10) ?? row.pages[row.pages.length - 1];
  return {
    index: item.index,
    fx: (x - (rowLeft + item.left)) / item.width,
    fy: (y - row.top) / item.height,
  };
}
/** Where that same spot of that page sits in a new layout. */
function place(rows: Row[], contentWidth: number, spot: { index: number; fx: number; fy: number }) {
  for (const row of rows) {
    const item = row.pages.find((p) => p.index === spot.index);
    if (item)
      return {
        x: (contentWidth - row.width) / 2 + item.left + spot.fx * item.width,
        y: row.top + spot.fy * item.height,
      };
  }
  return null;
}
interface ViewPoint {
  x: number;
  y: number;
}
export function Viewer({ tab }: { tab: Tab }) {
  const ref = useRef<HTMLDivElement>(null),
    space = useRef(false),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 900, height: 650 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; cx: number; cy: number } | null>(
    null,
  );
  const hand = useApp((s) => s.hand),
    presentation = useApp((s) => s.presentation),
    mode = useApp((s) => s.mode);
  const updating = useRef(false),
    lastDoc = useRef(tab.info.docId);
  // Zooming keeps one spot of the page still: the spot under the mouse for the wheel, the middle of the view
  // for the buttons and the keyboard, the middle of the drawn box for marquee zoom.
  const zoomAnchor = useRef<{ from: ViewPoint; to: ViewPoint } | null>(null),
    scrolled = useRef({ top: 0, left: 0 }),
    wheelTravel = useRef({ sum: 0, at: 0 }),
    measured = useRef(false),
    shown = useRef<{ rows: Row[]; width: number }>({ rows: [], width: 0 }),
    lastView = useRef({
      zoom: tab.zoom,
      page: tab.page,
      docId: tab.info.docId,
      layout: tab.layout,
      rotation: tab.rotation,
    });
  const scale = tab.zoom * CSS_DPI;
  const rows = useMemo(() => {
    const rows: Row[] = [];
    const groups: number[][] = [];
    if (tab.layout === 'single') groups.push([tab.page]);
    else if (tab.layout === 'continuous') tab.info.pages.forEach((_, i) => groups.push([i]));
    else {
      let i = 0;
      if (tab.layout === 'cover') {
        groups.push([0]);
        i = 1;
      }
      for (; i < tab.info.pages.length; i += 2)
        groups.push([i, i + 1].filter((n) => n < tab.info.pages.length));
    }
    let top = 24;
    for (const group of groups) {
      let left = 0;
      const pages = group.map((index) => {
        const page = tab.info.pages[index],
          rotated = tab.rotation % 180 !== 0;
        const width = (rotated ? page.height : page.width) * scale,
          height = (rotated ? page.width : page.height) * scale;
        const item = { index, left, width, height };
        left += width + 20;
        return item;
      });
      const height = Math.max(...pages.map((p) => p.height));
      rows.push({ top, height, pages, width: left - 20 });
      top += height + 24;
    }
    return rows;
  }, [tab.info.pages, tab.layout, tab.layout === 'single' ? tab.page : 0, tab.rotation, scale]);
  const total = (rows.at(-1)?.top || 0) + (rows.at(-1)?.height || 0) + 24,
    maxWidth = Math.max(view.width, ...rows.map((r) => r.width + 48));
  useEffect(() => {
    const el = ref.current!;
    const resize = new ResizeObserver(() => {
      measured.current = true;
      setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }));
    });
    resize.observe(el);
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // One zoom level per wheel notch, whatever the notch size set in Windows. A touchpad pinch or a
      // free-spinning wheel sends many small moves instead; those add up until they amount to a notch.
      const delta =
        e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
      if (!delta) return;
      const travel = wheelTravel.current,
        now = performance.now();
      if (now - travel.at > 300 || Math.sign(travel.sum) !== Math.sign(delta)) travel.sum = 0;
      travel.at = now;
      travel.sum += delta;
      if (Math.abs(delta) < 30 && Math.abs(travel.sum) < 60) return;
      travel.sum = 0;
      const current = useApp.getState().tabs.find((t) => t.info.docId === tab.info.docId)?.zoom;
      if (!current) return;
      const next = stepZoom(current, delta < 0 ? 1 : -1);
      if (next === current) return;
      const box = el.getBoundingClientRect(),
        at = { x: e.clientX - box.left, y: e.clientY - box.top };
      zoomAnchor.current = { from: at, to: at };
      useApp.getState().updateTab(tab.info.docId, { zoom: next, fit: undefined });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        space.current = true;
        el.style.cursor = 'grab';
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        space.current = false;
        el.style.cursor = '';
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      resize.disconnect();
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [tab.info.docId]);
  useLayoutEffect(() => {
    const el = ref.current,
      before = lastView.current;
    lastView.current = {
      zoom: tab.zoom,
      page: tab.page,
      docId: tab.info.docId,
      layout: tab.layout,
      rotation: tab.rotation,
    };
    const zoomOnly =
      before.zoom !== tab.zoom &&
      before.docId === tab.info.docId &&
      before.page === tab.page &&
      before.layout === tab.layout &&
      before.rotation === tab.rotation;
    if (zoomOnly && el) {
      const middle = { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      const anchor = zoomAnchor.current ?? { from: middle, to: middle };
      zoomAnchor.current = null;
      const spot = locate(
        shown.current.rows,
        shown.current.width,
        scrolled.current.left + anchor.from.x,
        scrolled.current.top + anchor.from.y,
      );
      const target = spot && place(rows, maxWidth, spot);
      if (target) {
        el.scrollLeft = target.x - anchor.to.x;
        el.scrollTop = target.y - anchor.to.y;
        scrolled.current = { top: el.scrollTop, left: el.scrollLeft };
        setView((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
        lastDoc.current = tab.info.docId;
        return;
      }
    }
    zoomAnchor.current = null;
    if (updating.current) {
      updating.current = false;
      return;
    }
    const row = rows.find((r) => r.pages.some((p) => p.index === tab.page));
    if (row && el) {
      el.scrollTop = row.top - 24;
      scrolled.current = { top: el.scrollTop, left: el.scrollLeft };
      setView((v) => ({ ...v, top: row.top - 24 }));
    }
    lastDoc.current = tab.info.docId;
  }, [tab.page, tab.info.docId, tab.layout, tab.zoom, tab.rotation, rows]);
  // "Fit width" and "Fit page" stay fitted when the view changes size: a side panel opens, the window is
  // resized. The page is not refitted while scrolling through pages of different sizes.
  useEffect(() => {
    if (!tab.fit || !measured.current) return;
    const current = useApp.getState().tabs.find((t) => t.info.docId === tab.info.docId);
    if (!current?.fit) return;
    const page = current.info.pages[current.page] ?? current.info.pages[0];
    const turned = current.rotation % 180 !== 0;
    const width = (turned ? page.height : page.width) * CSS_DPI,
      height = (turned ? page.width : page.height) * CSS_DPI;
    const paired = current.layout === 'two-page' || current.layout === 'cover';
    let zoom = paired ? (view.width - 68) / (width * 2) : (view.width - 48) / width;
    if (current.fit === 'page') zoom = Math.min(zoom, (view.height - 48) / height);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (Math.abs(zoom - current.zoom) > 0.0005)
      useApp.getState().updateTab(current.info.docId, { zoom });
  }, [tab.fit, tab.info.docId, tab.rotation, tab.layout, view.width, view.height]);
  // After the effect above has used it: remember the layout that is on screen now, for the next zoom.
  useLayoutEffect(() => {
    shown.current = { rows, width: maxWidth };
  });
  const onScroll = () => {
    const el = ref.current!;
    scrolled.current = { top: el.scrollTop, left: el.scrollLeft };
    setView({
      top: el.scrollTop,
      left: el.scrollLeft,
      width: el.clientWidth,
      height: el.clientHeight,
    });
    const row = rows.find((r) => r.top + r.height > el.scrollTop + el.clientHeight * 0.25);
    if (row && row.pages[0].index !== tab.page) {
      updating.current = true;
      useApp.getState().updateTab(tab.info.docId, { page: row.pages[0].index });
    }
  };
  return (
    <div
      className={`viewer ${hand ? 'hand' : ''} ${presentation ? 'presentation-view' : ''}`}
      data-testid="viewer"
      ref={ref}
      onScroll={onScroll}
      tabIndex={0}
      onKeyDown={(e) => {
        if (mode === 'Edit' || e.target instanceof HTMLInputElement) return;
        let page = tab.page;
        if (e.key === 'Home') page = 0;
        else if (e.key === 'End') page = tab.info.pageCount - 1;
        else if (['PageDown', 'ArrowRight', 'ArrowDown'].includes(e.key)) page++;
        else if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(e.key)) page--;
        else return;
        e.preventDefault();
        useApp
          .getState()
          .updateTab(tab.info.docId, { page: Math.max(0, Math.min(tab.info.pageCount - 1, page)) });
      }}
      onPointerDown={(e) => {
        if (hand || space.current || e.button === 1) {
          e.preventDefault();
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: ref.current!.scrollLeft,
            top: ref.current!.scrollTop,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        } else if (ref.current?.dataset.marquee === 'true') {
          const r = ref.current.getBoundingClientRect();
          setMarquee({
            x: e.clientX - r.left,
            y: e.clientY - r.top,
            cx: e.clientX - r.left,
            cy: e.clientY - r.top,
          });
          e.currentTarget.setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (drag.current) {
          ref.current!.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
          ref.current!.scrollTop = drag.current.top - (e.clientY - drag.current.y);
        }
        if (marquee) {
          const r = ref.current!.getBoundingClientRect();
          setMarquee({ ...marquee, cx: e.clientX - r.left, cy: e.clientY - r.top });
        }
      }}
      onPointerUp={() => {
        drag.current = null;
        if (marquee) {
          const width = Math.abs(marquee.cx - marquee.x);
          if (width > 10) {
            // The middle of the drawn box moves to the middle of the view.
            zoomAnchor.current = {
              from: { x: (marquee.x + marquee.cx) / 2, y: (marquee.y + marquee.cy) / 2 },
              to: { x: view.width / 2, y: view.height / 2 },
            };
            useApp.getState().updateTab(tab.info.docId, {
              zoom: Math.min(64, (tab.zoom * view.width) / width),
              fit: undefined,
            });
          }
          setMarquee(null);
          ref.current!.dataset.marquee = 'false';
        }
      }}
    >
      <div className="page-space" style={{ height: total, width: maxWidth }}>
        {rows.map((row) => (
          <div
            key={row.pages[0].index}
            className="page-row"
            style={{
              top: row.top,
              height: row.height,
              width: row.width,
              left: (maxWidth - row.width) / 2,
            }}
          >
            {row.pages.map((item) => {
              const visible =
                row.top + row.height > view.top - 400 && row.top < view.top + view.height + 400;
              const page = tab.info.pages[item.index];
              const x = (maxWidth - row.width) / 2 + item.left;
              return (
                <div
                  className="page-placeholder"
                  key={page.id}
                  data-page-number={item.index + 1}
                  style={{ left: item.left, width: item.width, height: item.height }}
                >
                  {visible ? (
                    <PageView
                      tab={tab}
                      page={page}
                      visible={visible}
                      viewport={{
                        x: Math.max(0, view.left - x),
                        y: Math.max(0, view.top - row.top),
                        width: view.width,
                        height: view.height,
                      }}
                    />
                  ) : (
                    <span className="page-placeholder-label">{item.index + 1}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {marquee && (
        <div
          className="zoom-marquee"
          style={{
            left: Math.min(marquee.x, marquee.cx) + view.left,
            top: Math.min(marquee.y, marquee.cy) + view.top,
            width: Math.abs(marquee.cx - marquee.x),
            height: Math.abs(marquee.cy - marquee.y),
          }}
        />
      )}
    </div>
  );
}
