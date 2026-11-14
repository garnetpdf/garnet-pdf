import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileImage,
  FilePlus2,
  FileText,
  FolderOpen,
  History,
  Layers,
  ListFilter,
  Maximize2,
  Minus,
  PanelRight,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import type { FileDescriptor, RecentFile, RecoveryEntry } from '../shared/ipc';
import type { DocumentInfo, EngineOps, JournalState, OutlineItem } from '../shared/engine-api';
import { activeTab, useApp, type Tab } from './store';
import {
  actions,
  closeChoice,
  encryptionChoice,
  printChoice,
  engine,
  host,
  initializePlugins,
  toast,
  useUI,
} from './runtime';
import { shortcutForEvent } from './plugin-host/host';
import { stepZoom } from './zoom';
import appMark from '../../resources/icon.svg';
import appMarkSmall from '../../resources/icon-small.svg';
import { redactionPending, saveProtection, shell } from './actions';
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  SegmentedControl,
  Tabs,
  Toast,
  Toolbar,
} from './ui';
import { installShortcutHints, isMac, keys, setPlatform } from './ui/platform';
import './ui/platform.css';
import { runMenuCommand } from './menu-commands';
import { Viewer } from './viewer/Viewer';
import { CSS_DPI, Thumbnail } from './viewer/PageView';
import { cache } from './viewer/render-cache';

/** Name, version, licence and links, at the foot of Settings. Links open in the browser only after a click. */
function About() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.garnet
      .appInfo()
      .then((info) => setVersion(info.version))
      .catch(() => undefined);
  }, []);
  const link = (label: string, url: string) => (
    <button
      type="button"
      className="link"
      onClick={() => void window.garnet.openExternal(url).catch(() => undefined)}
    >
      {label}
    </button>
  );
  return (
    <section className="about" aria-label="About Garnet PDF">
      <img src={appMark} alt="" />
      <div>
        <strong>Garnet PDF {version}</strong>
        <p>Free for everyone. Your files stay on your computer.</p>
        <p className="about-links">
          {link('garnetpdf.com', 'https://garnetpdf.com')}
          {link('Source code', 'https://garnetpdf.com/source')}
          {link('Licences', 'https://garnetpdf.com/licences')}
        </p>
        <p className="muted">
          Free software under the GNU Affero General Public License, version 3. Made by{' '}
          {link('Code2Box', 'https://code2box.com')}.
        </p>
      </div>
    </section>
  );
}
let started = false;
async function openFiles(files: FileDescriptor[]) {
  for (const file of files) {
    try {
      const existing = useApp.getState().tabs.find((t) => t.file.handle === file.handle);
      if (existing) {
        useApp.getState().set({ activeId: existing.info.docId });
        continue;
      }
      const bytes = await window.garnet.readFile(file.handle);
      let password: string | undefined, info: DocumentInfo;
      for (;;) {
        try {
          info = await engine.call('core.open', { bytes: bytes.slice(0), password });
          break;
        } catch (e) {
          if (!String(e).includes('PASSWORD')) throw e;
          const result = await host.ctx.ui.prompt(
            password ? 'Incorrect password. Try again.' : 'Enter document password',
          );
          if (result === null) break;
          password = result;
        }
      }
      if (!info!) continue;
      const previous = (await window.garnet.recent.list()).find(
        (r) => r.handle === file.handle,
      )?.viewState;
      const s = useApp.getState(),
        defaultZoom = s.settings.defaultZoom;
      const zoom =
        typeof defaultZoom === 'number'
          ? defaultZoom
          : defaultZoom === 'actual'
            ? 1
            : Math.max(
                0.1,
                Math.min(
                  64,
                  (window.innerWidth - 300) / (info.pages[0].width * CSS_DPI),
                  defaultZoom === 'fit-page'
                    ? (window.innerHeight - 205) / (info.pages[0].height * CSS_DPI)
                    : 64,
                ),
              );
      s.set({
        tabs: [
          ...s.tabs,
          {
            info,
            file,
            page: previous ? Math.min(previous.page, info.pageCount - 1) : 0,
            zoom: previous?.zoom ?? zoom,
            fit: previous
              ? previous.fit
              : defaultZoom === 'fit-width'
                ? 'width'
                : defaultZoom === 'fit-page'
                  ? 'page'
                  : undefined,
            rotation: previous?.rotation ?? 0,
            layout: previous?.layout ?? 'continuous',
          },
        ],
        activeId: info.docId,
        hits: [],
        query: '',
      });
      host.emitDocument('opened', {
        docId: info.docId,
        name: file.name,
        pageId: info.pages[0].id,
        pageCount: info.pageCount,
      });
    } catch (e) {
      const text = String((e as Error)?.message ?? e);
      toast(
        text.includes('DAMAGED_FILE')
          ? `${file.name} is damaged and cannot be opened.`
          : `Could not open ${file.name}: ${text}`,
      );
    }
  }
}
async function saveTab(tab: Tab, saveAs = false) {
  let encryption: EngineOps['core.save']['args']['encryption'] = saveProtection.get(tab.info.docId);
  let verificationPassword =
    encryption && encryption.mode !== 'remove' ? encryption.userPassword : undefined;
  if (tab.info.encrypted && !encryption) {
    const mode = await encryptionChoice(!!tab.recoverySourceId);
    if (mode === null) return false;
    if (mode === 'remove') encryption = { mode: 'remove' };
    else {
      const userPassword = await host.ctx.ui.prompt(
        mode === 'keep'
          ? 'Current password for opening the document'
          : 'New password for opening the saved copy',
      );
      if (userPassword === null) return false;
      const ownerPassword = await host.ctx.ui.prompt(
        mode === 'keep' ? 'Current owner password' : 'New owner password',
        mode === 'set' ? userPassword : '',
      );
      if (ownerPassword === null) return false;
      if (!ownerPassword) {
        toast('Enter an owner password or cancel the save.');
        return false;
      }
      encryption = { mode: mode === 'keep' ? 'keep' : 'set', userPassword, ownerPassword };
      verificationPassword = userPassword;
    }
  }
  const saved = await engine.call('core.save', { docId: tab.info.docId, encryption });
  const file = await window.garnet.saveFile({
    // New documents (combined, extracted, restored) have no file yet: an empty handle means Save As.
    handle: tab.file.handle || undefined,
    bytes: saved.bytes,
    expectedPageCount: saved.pageCount,
    saveAs:
      saveAs ||
      !tab.file.handle ||
      tab.info.hasSignatures ||
      !!tab.recoverySourceId ||
      tab.file.kind === 'image',
    suggestedName:
      tab.file.kind === 'image' ? tab.file.name.replace(/\.[^.]+$/, '.pdf') : tab.file.name,
    hasSignatures: tab.info.hasSignatures,
    recoveryId: tab.info.docId,
    savedRevision: saved.revision,
    verificationPassword,
    redactionApplied: redactionPending.has(tab.info.docId),
  });
  if (!file) return false;
  if (encryption) saveProtection.set(tab.info.docId, encryption);
  if (tab.recoverySourceId) await window.garnet.recovery.delete(tab.recoverySourceId);
  useApp.getState().updateTab(tab.info.docId, { file });
  await engine.call('core.markSaved', {
    docId: tab.info.docId,
    revision: saved.revision,
    encryption,
  });
  if (encryption)
    useApp.getState().updateInfo(tab.info.docId, { encrypted: encryption.mode !== 'remove' });
  const cleared = redactionPending.delete(tab.info.docId);
  if (cleared) await engine.call('core.clearHistory', { docId: tab.info.docId });
  host.emitDocument('saved', {
    docId: tab.info.docId,
    name: file.name,
    pageId: tab.info.pages[tab.page].id,
    pageCount: tab.info.pageCount,
  });
  toast(
    cleared
      ? `Saved ${file.name}. Undo history cleared so the removed content cannot be recovered.`
      : `Saved ${file.name}`,
  );
  return true;
}
async function closeTab(id: string) {
  const s = useApp.getState(),
    tab = s.tabs.find((t) => t.info.docId === id);
  if (!tab) return true;
  if (tab.info.dirty) {
    const choice = await closeChoice(tab.file.name);
    if (choice === null) return false;
    if (choice === 'save' && !(await saveTab(tab))) return false;
  }
  await engine.call('core.close', { docId: id });
  saveProtection.delete(id);
  await window.garnet.recovery.delete(id);
  const remaining = useApp.getState().tabs.filter((t) => t.info.docId !== id);
  useApp.getState().set({
    tabs: remaining,
    activeId: s.activeId === id ? remaining.at(-1)?.info.docId || null : s.activeId,
  });
  host.emitDocument('closed', {
    docId: id,
    name: tab.file.name,
    pageId: tab.info.pages[tab.page]?.id,
    pageCount: tab.info.pageCount,
  });
  cache.clear();
  return true;
}
async function restoreRecovery(entry: RecoveryEntry) {
  try {
    const bytes = await window.garnet.recovery.read(entry.id);
    const info = await engine.call('core.open', { bytes, unsaved: true });
    const file: FileDescriptor = {
      handle: entry.originalHandle || '',
      name: entry.name,
      kind: 'pdf',
      size: bytes.byteLength,
      lastModified: entry.createdAt,
    };
    const s = useApp.getState();
    s.set({
      tabs: [
        ...s.tabs,
        {
          recoverySourceId: entry.id,
          info: { ...info, dirty: true, encrypted: entry.encrypted },
          file,
          page: 0,
          zoom: 1,
          rotation: 0,
          layout: 'continuous',
        },
      ],
      activeId: info.docId,
    });
    toast(`Restored ${entry.name}. Save a copy to keep it.`);
  } catch (e) {
    toast(String(e));
  }
}
function setZoom(value: string) {
  const tab = activeTab();
  if (!tab) return;
  const viewer = document.querySelector('.viewer');
  const page = tab.info.pages[tab.page];
  let zoom = Number(value);
  if (value === 'fit-width') zoom = ((viewer?.clientWidth || 900) - 48) / (page.width * CSS_DPI);
  if (value === 'fit-page')
    zoom = Math.min(
      ((viewer?.clientWidth || 900) - 48) / (page.width * CSS_DPI),
      ((viewer?.clientHeight || 650) - 48) / (page.height * CSS_DPI),
    );
  useApp.getState().updateTab(tab.info.docId, {
    zoom: Math.max(0.1, Math.min(64, zoom)),
    fit: value === 'fit-width' ? 'width' : value === 'fit-page' ? 'page' : undefined,
  });
}
async function smoke(info: DocumentInfo) {
  const checks: Record<string, boolean> = {},
    timings: Record<string, number> = {};
  try {
    const docId = info.docId,
      first = info.pages[0];
    checks.open = info.pageCount > 0;
    const begin = performance.now();
    const render = await engine.call('core.render', { docId, pageId: first.id, scale: 1, dpr: 1 });
    timings.renderMs = performance.now() - begin;
    const canvas = document.createElement('canvas');
    canvas.width = render.width;
    canvas.height = render.height;
    if (render.bitmap) {
      canvas.getContext('2d')!.drawImage(render.bitmap, 0, 0);
      render.bitmap.close();
    }
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    checks.render = pixels.some((n, i) => i % 4 !== 3 && n < 240);
    const rotated = await engine.call('example.rotate', { docId, pageId: first.id, degrees: 90 });
    checks.rotate = rotated.pages[0].rotation === (first.rotation + 90) % 360;
    const undone = await engine.call('core.undo', { docId });
    checks.undo = undone.pages[0].rotation === first.rotation;
    const redone = await engine.call('core.redo', { docId });
    checks.redo = redone.pages[0].rotation === rotated.pages[0].rotation;
    const saved = await engine.call('core.save', { docId });
    const file = await window.garnet.smoke.save(saved.bytes, saved.pageCount);
    checks.save = file.size > 0;
    const reopened = await engine.call('core.open', {
      bytes: await window.garnet.readFile(file.handle),
    });
    checks.reopen =
      reopened.pageCount === info.pageCount &&
      !reopened.repaired &&
      reopened.pages[0].rotation === rotated.pages[0].rotation;
    await engine.call('core.close', { docId: reopened.docId });
    await engine.call('core.markSaved', { docId, revision: saved.revision });
    const after = await engine.call('core.undo', { docId });
    checks.undoAfterSave = after.dirty && after.pages[0].rotation === first.rotation;
    let peakHeap = 0;
    for (let cycle = 0; cycle < 50; cycle++) {
      const before = (await engine.call('core.pageInfo', { docId }))[0].rotation;
      await engine.call('example.rotate', { docId, pageId: first.id, degrees: 90 });
      const bytes = await engine.call('core.save', { docId });
      const checked = await engine.call('core.open', { bytes: bytes.bytes });
      if (checked.repaired || checked.pageCount !== info.pageCount)
        throw new Error(`Cycle ${cycle} reopen failed`);
      await engine.call('core.close', { docId: checked.docId });
      await engine.call('core.markSaved', { docId, revision: bytes.revision });
      const undone = await engine.call('core.undo', { docId });
      if (!undone.dirty || undone.pages[0].rotation !== before)
        throw new Error(`Cycle ${cycle} undo failed`);
      const memory = await engine.call('core.memory', { docId });
      peakHeap = Math.max(peakHeap, memory.wasmHeapBytes || 0);
    }
    checks.fiftySaveUndoCycles = true;
    checks.workerMemory = peakHeap > 0 && peakHeap < 1.2 * 1024 ** 3;
    timings.peakWorkerWasmBytes = peakHeap;
    for (const scale of [1, 2]) {
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        const result = await engine.call('core.render', {
          docId,
          pageId: first.id,
          scale: scale * CSS_DPI,
          dpr: 1,
          cache: false,
        });
        samples.push(result.elapsedMs);
        result.bitmap?.close();
      }
      samples.sort((a, b) => a - b);
      timings[`render${scale * 100}p50Ms`] = samples[4];
      timings[`render${scale * 100}p95Ms`] = samples[9];
    }
    checks.offline = (await window.garnet.diagnostics.networkAttempts()).length === 0;
    if (Object.values(checks).some((value) => !value))
      throw new Error('One or more smoke assertions failed');
    await window.garnet.smoke.complete({ checks, timings });
  } catch (e) {
    await window.garnet.smoke.complete({ checks, error: String(e), timings });
  }
}

export function App() {
  const state = useApp(),
    tab = state.tabs.find((t) => t.info.docId === state.activeId),
    ui = useUI();
  useSyncExternalStore(host.subscribe, host.snapshot);
  const [recent, setRecent] = useState<RecentFile[]>([]),
    [settingsOpen, setSettingsOpen] = useState(false),
    [palette, setPalette] = useState(false),
    [paletteQuery, setPaletteQuery] = useState(''),
    [recoveries, setRecoveries] = useState<RecoveryEntry[]>([]),
    [journal, setJournal] = useState<JournalState>({ position: 0, steps: [] }),
    [printing, setPrinting] = useState<{ page: number; total: number } | null>(null),
    [aboutOpen, setAboutOpen] = useState(false),
    [fullscreen, setFullscreen] = useState(false);
  const mac = state.platform === 'darwin';
  const printCancel = useRef(false),
    draggedTab = useRef<string | null>(null);
  const refreshRecent = () =>
    window.garnet.recent
      .list()
      .then(setRecent)
      .catch((e) => toast(String(e)));
  actions.open = async () => openFiles(await window.garnet.openDialog());
  shell.openBytes = async (bytes, name) => {
    const info = await engine.call('core.open', { bytes, unsaved: true });
    const file: FileDescriptor = {
      handle: '',
      name,
      kind: 'pdf',
      size: bytes.byteLength,
      lastModified: Date.now(),
    };
    const s = useApp.getState();
    s.set({
      tabs: [...s.tabs, { info, file, page: 0, zoom: 1, rotation: 0, layout: 'continuous' }],
      activeId: info.docId,
      hits: [],
      query: '',
    });
    host.emitDocument('opened', {
      docId: info.docId,
      name,
      pageId: info.pages[0].id,
      pageCount: info.pageCount,
    });
  };
  actions.save = async () => {
    const t = activeTab();
    if (t) await saveTab(t);
  };
  actions.saveAs = async () => {
    const t = activeTab();
    if (t) await saveTab(t, true);
  };
  actions.undo = async () => {
    if (await host.undoLocal()) return;
    const t = activeTab();
    if (t) await engine.call('core.undo', { docId: t.info.docId });
  };
  actions.redo = async () => {
    if (await host.redoLocal()) return;
    const t = activeTab();
    if (t) await engine.call('core.redo', { docId: t.info.docId });
  };
  actions.find = () => useApp.getState().set({ findOpen: true });
  actions.settings = () => setSettingsOpen(true);
  actions.zoomIn = () => setZoom(String(stepZoom(activeTab()?.zoom || 1, 1)));
  actions.zoomOut = () => setZoom(String(stepZoom(activeTab()?.zoom || 1, -1)));
  actions.rotateView = () => {
    const t = activeTab();
    if (t) useApp.getState().updateTab(t.info.docId, { rotation: (t.rotation + 90) % 360 });
  };
  actions.fullscreen = () => window.garnet.window.fullscreen(!fullscreen);
  actions.sidebar = () =>
    useApp.getState().set({ sidebar: useApp.getState().sidebar ? '' : 'Thumbnails' });
  actions.layout = () => {
    const t = activeTab();
    if (t) {
      const layouts = ['continuous', 'single', 'two-page', 'cover'] as const;
      useApp.getState().updateTab(t.info.docId, {
        layout: layouts[(layouts.indexOf(t.layout) + 1) % layouts.length],
      });
    }
  };
  actions.hand = () => useApp.getState().set({ hand: !useApp.getState().hand });
  actions.marquee = () => {
    const el = document.querySelector<HTMLElement>('.viewer');
    if (el) {
      el.dataset.marquee = 'true';
      toast('Drag a rectangle over the area to zoom.');
    }
  };
  actions.presentation = async () => {
    const t = activeTab();
    if (t) useApp.getState().updateTab(t.info.docId, { layout: 'single' });
    useApp.getState().set({ presentation: true });
    await window.garnet.window.fullscreen(true);
    setZoom('fit-page');
  };
  actions.print = async () => {
    const t = activeTab();
    if (!t) return;
    const choice = await printChoice(t.info.pageCount);
    if (choice === null) return;
    const { range, copies, grayscale, sizing } = JSON.parse(choice) as {
      range: string;
      copies: number;
      grayscale: boolean;
      sizing: 'fit' | 'actual';
    };
    const indices = new Set<number>();
    for (const part of range.split(',')) {
      const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!match) throw new Error('Enter a valid page range.');
      const from = Number(match[1]),
        to = Number(match[2] || match[1]);
      if (from < 1 || to > t.info.pageCount || to < from)
        throw new Error('Page range is outside this document.');
      for (let i = from; i <= to; i++) indices.add(i - 1);
    }
    printCancel.current = false;
    let completed = 0;
    const printId = await window.garnet.printStream.begin({ copies, grayscale, sizing });
    try {
      for (const index of indices) {
        if (printCancel.current) return;
        setPrinting({ page: completed + 1, total: indices.size });
        const p = t.info.pages[index];
        const r = await engine.call(
          'core.render',
          { docId: t.info.docId, pageId: p.id, scale: 300 / 72, dpr: 1, annots: true, forms: true },
          { priority: 10 },
        );
        const canvas = document.createElement('canvas');
        canvas.width = r.width;
        canvas.height = r.height;
        canvas.getContext('2d')!.drawImage(r.bitmap!, 0, 0);
        r.bitmap!.close();
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        if (!blob) throw new Error('Could not prepare print page');
        await window.garnet.printStream.addPage(printId, {
          png: await blob.arrayBuffer(),
          width: p.width,
          height: p.height,
        });
        completed++;
      }
      if (!printCancel.current) await window.garnet.printStream.finish(printId);
    } finally {
      await window.garnet.printStream.cancel(printId);
      setPrinting(null);
    }
  };
  useEffect(() => {
    if (started) return;
    started = true;
    initializePlugins();
    void (async () => {
      const settings = await window.garnet.settings.get();
      useApp.getState().set({ settings });
      const startup = await window.garnet.startup();
      useApp.getState().set({ platform: startup.platform });
      setPlatform(startup.platform);
      installShortcutHints();
      await openFiles(startup.files);
      if (startup.smoke) {
        const t = activeTab();
        if (t) await smoke(t.info);
        else
          await window.garnet.smoke.complete({
            checks: { open: false },
            error: 'Could not open input',
          });
        return;
      }
      setRecoveries(await window.garnet.recovery.list());
      await refreshRecent();
    })().catch((e) => toast(String(e)));
    const off = window.garnet.onOpenFiles((files) => {
      void openFiles(files).then(refreshRecent);
    });
    const close = window.garnet.onCloseRequested(() => {
      void (async () => {
        for (const t of [...useApp.getState().tabs]) if (!(await closeTab(t.info.docId))) return;
        await window.garnet.window.close();
      })();
    });
    // The menu bar of a Mac (and the hidden shortcut menu elsewhere) sends its commands here.
    const menu = window.garnet.menu.onCommand((command) => {
      void runMenuCommand(command, {
        dialogOpen: () => !!document.querySelector('[role=dialog]'),
        focused: () => document.activeElement,
        hasCommand: (id) => host.commands.has(id),
        execute: (id) => host.execute(id),
        textCommand: (name) => void document.execCommand(name),
        about: () => setAboutOpen(true),
        closeTab: async () => {
          const t = activeTab();
          if (t) await closeTab(t.info.docId);
          else await window.garnet.window.close();
        },
        setZoom,
        setMode: (mode) => {
          if (host.modes.has(mode)) useApp.getState().set({ mode });
        },
      }).catch((e) => toast(String(e)));
    });
    const full = window.garnet.window.onFullScreen(setFullscreen);
    return () => {
      off();
      close();
      menu();
      full();
    };
  }, []);
  useEffect(() => {
    // What the Mac menu bar greys out and ticks.
    if (!mac) return;
    void window.garnet.menu
      .setState({ hasDocument: !!tab, mode: state.mode, modes: [...host.modes.keys()] })
      .catch(() => undefined);
  }, [mac, !!tab, state.mode, host.modes.size]);
  useEffect(() => {
    if (!state.tabs.length) void refreshRecent();
  }, [state.tabs.length]);
  useEffect(() => {
    const theme = state.settings.theme;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [state.settings.theme]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useApp.getState().presentation) {
        useApp.getState().set({ presentation: false });
        void window.garnet.window.fullscreen(false);
        return;
      }
      // On a Mac shortcuts use Command. Control belongs to the system there: its text keys
      // (Control+A, Control+E) and Control+Command+F for full screen must not run app commands.
      if ((isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (document.querySelector('[role=dialog]')) return;
      if (isMac() && e.ctrlKey) return;
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable;
      if (typing && !e.ctrlKey && !e.metaKey) return;
      const command = host.keybindings.get(shortcutForEvent(e));
      // In a text field on a Mac, Command+Z undoes the typing: the Edit menu passes it to the field.
      if (isMac() && typing && (command === 'view.undo' || command === 'view.redo')) return;
      if (command) {
        e.preventDefault();
        void host.execute(command).catch((e) => toast(String(e)));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!tab) return;
    void engine
      .call('core.history', { docId: tab.info.docId })
      .then((r) => setJournal(r.journal))
      .catch(() => {});
  }, [tab?.info.docId, tab?.info.revision, host.snapshot()]);
  useEffect(() => {
    if (!tab || !state.query) {
      state.set({ hits: [] });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void engine
        .call(
          'core.search',
          {
            docId: tab.info.docId,
            query: state.query,
            caseSensitive: state.caseSensitive,
            wholeWord: state.wholeWord,
          },
          {
            signal: controller.signal,
            onProgress: (data) => {
              if (data && typeof data === 'object' && 'hit' in data)
                useApp.getState().set({
                  hits: [
                    ...useApp.getState().hits,
                    (data as { hit: (typeof state.hits)[number] }).hit,
                  ],
                });
            },
          },
        )
        .then((hits) => {
          state.set({ hits, hitIndex: 0 });
          if (hits.length) state.updateTab(tab.info.docId, { page: hits[0].pageIndex });
        })
        .catch((e) => {
          if (!controller.signal.aborted) toast(String(e));
        });
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tab?.info.docId, tab?.info.revision, state.query, state.caseSensitive, state.wholeWord]);
  useEffect(() => {
    const interval = setInterval(
      () => {
        void (async () => {
          for (const t of useApp.getState().tabs) {
            if (!t.info.dirty) continue;
            const snapshot = await engine.call('core.snapshot', { docId: t.info.docId });
            await window.garnet.recovery.write(
              t.info.docId,
              t.file.name,
              t.file.handle || undefined,
              snapshot.bytes,
              snapshot.revision,
              t.info.encrypted,
            );
          }
        })().catch((e) => toast(`Recovery snapshot: ${String(e)}`));
      },
      Math.max(10, state.settings.recoveryIntervalSeconds) * 1000,
    );
    return () => clearInterval(interval);
  }, [state.settings.recoveryIntervalSeconds]);
  useEffect(() => {
    if (!tab?.file.handle) return;
    const id = setTimeout(() => {
      void window.garnet.recent
        .setView(tab.file.handle, {
          page: tab.page,
          zoom: tab.zoom,
          fit: tab.fit,
          rotation: tab.rotation,
          layout: tab.layout,
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(id);
  }, [tab?.file.handle, tab?.page, tab?.zoom, tab?.fit, tab?.rotation, tab?.layout]);
  const execute = (id: string) => void host.execute(id).catch((e) => toast(String(e)));
  const activePage = tab?.info.pages[tab.page];
  return (
    <div
      className={`app ${state.presentation ? 'presentation' : ''}${mac ? ' mac' : ''}${fullscreen ? ' fullscreen' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void Promise.all(
            Array.from(e.dataTransfer.files).map((f) => window.garnet.registerDroppedFile(f)),
          )
            .then(openFiles)
            .catch((e) => toast(String(e)));
        }
      }}
    >
      <header className="titlebar">
        <div className="brand">
          <img src={appMarkSmall} alt="" />
          <span>Garnet PDF</span>
        </div>
        <Tabs>
          {state.tabs.map((t) => (
            <div
              className={`document-tab ${t.info.docId === state.activeId ? 'active' : ''}`}
              key={t.info.docId}
              draggable
              onDragStart={() => (draggedTab.current = t.info.docId)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = state.tabs.findIndex((x) => x.info.docId === draggedTab.current),
                  to = state.tabs.indexOf(t);
                if (from >= 0) {
                  const tabs = [...state.tabs];
                  tabs.splice(to, 0, ...tabs.splice(from, 1));
                  state.set({ tabs });
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) void closeTab(t.info.docId);
              }}
            >
              <button
                role="tab"
                aria-selected={t.info.docId === state.activeId}
                onClick={() => {
                  state.set({ activeId: t.info.docId, hits: [], query: '' });
                  host.ctx.selection.set([]);
                }}
              >
                <FileText size={13} className="tab-file" />
                <span>{t.file.name}</span>
                {t.info.dirty && <i className="dirty-dot" aria-label="Unsaved changes" />}
              </button>
              <IconButton
                label={`Close ${t.file.name}`}
                onClick={() => void closeTab(t.info.docId).catch((e) => toast(String(e)))}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
        </Tabs>
        <IconButton label="Open files" shortcut="Ctrl+O" onClick={() => execute('view.open')}>
          <Plus size={16} />
        </IconButton>
        <div
          className="window-controls"
          style={state.platform === 'win32' ? { visibility: 'hidden', width: 138 } : undefined}
        >
          <IconButton label="Minimize" onClick={() => void window.garnet.window.minimize()}>
            <Minus size={14} />
          </IconButton>
          <IconButton label="Maximize" onClick={() => void window.garnet.window.maximize()}>
            <Maximize2 size={12} />
          </IconButton>
          <IconButton
            label="Close window"
            onClick={async () => {
              for (const t of [...state.tabs]) if (!(await closeTab(t.info.docId))) return;
              await window.garnet.window.close();
            }}
          >
            <X size={15} />
          </IconButton>
        </div>
      </header>
      <div className="mode-row">
        <SegmentedControl
          label="Modes"
          options={[...host.modes.keys()]}
          value={state.mode}
          onChange={(mode) => state.set({ mode })}
        />
        <Toolbar label="File actions">
          <IconButton label="Open files" shortcut="Ctrl+O" onClick={() => execute('view.open')}>
            <FolderOpen size={17} />
          </IconButton>
          <IconButton
            label="Save"
            shortcut="Ctrl+S"
            disabled={!tab}
            onClick={() => execute('view.save')}
          >
            <Check size={17} />
          </IconButton>
          <IconButton label="Command palette" shortcut="Ctrl+K" onClick={() => setPalette(true)}>
            <Search size={17} />
          </IconButton>
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={17} />
          </IconButton>
        </Toolbar>
      </div>
      {tab && (
        <div className="context-toolbar">
          <Toolbar label={`${state.mode} tools`}>
            {(host.toolbar.get(state.mode) || []).map((item) => {
              const command = host.commands.get(item.command);
              if (!command) return null;
              const Icon = command.icon;
              return (
                <Button
                  key={item.id}
                  title={
                    command.shortcut
                      ? `${command.title} (${keys(command.shortcut)})`
                      : command.title
                  }
                  onClick={() => execute(command.id)}
                >
                  {Icon && <Icon size={16} />}
                  <span>{item.label || command.title}</span>
                </Button>
              );
            })}
            {!host.toolbar.get(state.mode)?.length && (
              <span className="context-placeholder">
                {state.mode === 'Edit'
                  ? 'Select an object on the page to edit it.'
                  : `${state.mode} tools will appear here when installed.`}
              </span>
            )}
          </Toolbar>
          <Toolbar label="View controls">
            <IconButton label="Zoom out" onClick={() => execute('view.zoomOut')}>
              <Minus size={15} />
            </IconButton>
            <select
              aria-label="Zoom"
              className="zoom-select"
              data-zoom={tab.zoom}
              value={tab.fit ? `fit-${tab.fit}` : String(tab.zoom)}
              onChange={(e) => setZoom(e.target.value)}
            >
              {!tab.fit &&
                ![0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16, 32, 64].includes(tab.zoom) && (
                  <option value={tab.zoom}>{Math.round(tab.zoom * 100)}%</option>
                )}
              {[0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16, 32, 64].map((v) => (
                <option key={v} value={v}>
                  {v * 100}%
                </option>
              ))}
              <option value="fit-width">
                Fit width{tab.fit === 'width' ? ` (${Math.round(tab.zoom * 100)}%)` : ''}
              </option>
              <option value="fit-page">
                Fit page{tab.fit === 'page' ? ` (${Math.round(tab.zoom * 100)}%)` : ''}
              </option>
            </select>
            <IconButton label="Zoom in" onClick={() => execute('view.zoomIn')}>
              <Plus size={15} />
            </IconButton>
            <span className="separator" />
            <IconButton
              label="Inspector"
              onClick={() => state.set({ inspector: !state.inspector })}
            >
              <PanelRight size={16} />
            </IconButton>
          </Toolbar>
        </div>
      )}
      {tab?.info.repaired && (
        <div className="notice" role="status">
          <CircleHelp size={15} />
          This file was repaired while opening. Save a copy before editing further.
          {tab.info.notices?.length ? ` ${tab.info.notices.join(' ')}` : ''}
        </div>
      )}
      {tab?.info.hasSignatures && (
        <div className="notice">Changes will invalidate the signature. Saving creates a copy.</div>
      )}
      {tab ? (
        <div className="workspace">
          <nav className="sidebar-rail" aria-label="Document panels">
            {(
              [
                ['Thumbnails', FileText],
                ['Bookmarks', Bookmark],
                ['Attachments', Paperclip],
                ['Layers', Layers],
                ['Search results', Search],
                ['History', History],
              ] as const
            ).map(([name, Icon]) => (
              <IconButton
                key={name}
                label={name}
                className={`icon-button ${state.sidebar === name ? 'selected' : ''}`}
                onClick={() => state.set({ sidebar: state.sidebar === name ? '' : name })}
              >
                <Icon size={17} />
              </IconButton>
            ))}
            {[...host.panels.left.values()]
              .filter((p) => !['Bookmarks', 'Attachments', 'Layers'].includes(p.id))
              .map((p) => {
                const Icon = p.icon ?? PanelLeft;
                return (
                  <IconButton
                    key={p.id}
                    label={p.title}
                    className={`icon-button ${state.sidebar === p.id ? 'selected' : ''}`}
                    onClick={() => state.set({ sidebar: state.sidebar === p.id ? '' : p.id })}
                  >
                    <Icon size={17} />
                  </IconButton>
                );
              })}
          </nav>
          {state.sidebar && (
            <aside className="sidebar-content">
              <h2 className="panel-title">{state.sidebar}</h2>
              <div className="sidebar-scroll">
                {state.sidebar === 'Thumbnails' ? (
                  tab.info.pages.map((p) => (
                    <Thumbnail
                      key={p.id}
                      tab={tab}
                      page={p}
                      active={tab.page === p.index}
                      onClick={() => state.updateTab(tab.info.docId, { page: p.index })}
                    />
                  ))
                ) : state.sidebar === 'Bookmarks' && !host.panels.left.has('Bookmarks') ? (
                  <Outline
                    items={tab.info.outline}
                    onPage={(page) => state.updateTab(tab.info.docId, { page })}
                  />
                ) : state.sidebar === 'History' ? (
                  <>
                    <button
                      className="history-item"
                      aria-current={journal.position === 0}
                      onClick={() =>
                        void engine.call('core.gotoHistory', { docId: tab.info.docId, position: 0 })
                      }
                    >
                      Opened document
                    </button>
                    {journal.steps.map((step, i) => (
                      <button
                        className="history-item"
                        aria-current={journal.position === i + 1}
                        key={i}
                        onClick={() =>
                          void engine.call('core.gotoHistory', {
                            docId: tab.info.docId,
                            position: i + 1,
                          })
                        }
                      >
                        {step}
                      </button>
                    ))}
                    {host.getLocalHistory().steps.map((s, i) => (
                      <div className="history-item" key={`local-${i}`}>
                        Demo: {s}
                      </div>
                    ))}
                  </>
                ) : state.sidebar === 'Search results' ? (
                  state.hits.length ? (
                    state.hits.map((hit, i) => (
                      <button
                        key={i}
                        className="search-result"
                        onClick={() => {
                          state.set({ hitIndex: i });
                          state.updateTab(tab.info.docId, { page: hit.pageIndex });
                        }}
                      >
                        Page {hit.pageIndex + 1}: {state.query}
                      </button>
                    ))
                  ) : (
                    <EmptyState>Find text with Ctrl+F.</EmptyState>
                  )
                ) : host.panels.left.has(state.sidebar) ? (
                  (() => {
                    const Component = host.panels.left.get(state.sidebar)!.component;
                    return <Component />;
                  })()
                ) : (
                  <EmptyState>
                    This panel will be available with the document tools package.
                  </EmptyState>
                )}
              </div>
            </aside>
          )}
          <div className="viewer-container">
            <Viewer tab={tab} />
            {state.findOpen && (
              <div className="findbar">
                <Search size={15} />
                <input
                  aria-label="Find text"
                  placeholder="Find in document"
                  autoFocus
                  value={state.query}
                  onChange={(e) => state.set({ query: e.target.value })}
                />
                <span className="muted">
                  {state.hits.length
                    ? `${state.hitIndex + 1} of ${state.hits.length}`
                    : '0 results'}
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={state.caseSensitive}
                    onChange={(e) => state.set({ caseSensitive: e.target.checked })}
                  />
                  Case
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={state.wholeWord}
                    onChange={(e) => state.set({ wholeWord: e.target.checked })}
                  />
                  Word
                </label>
                {[-1, 1].map((step) => (
                  <IconButton
                    key={step}
                    label={step < 0 ? 'Previous match' : 'Next match'}
                    disabled={!state.hits.length}
                    onClick={() => {
                      const hitIndex =
                        (state.hitIndex + step + state.hits.length) % state.hits.length;
                      state.set({ hitIndex });
                      state.updateTab(tab.info.docId, { page: state.hits[hitIndex].pageIndex });
                    }}
                  >
                    {step < 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                  </IconButton>
                ))}
                <IconButton
                  label="Close find"
                  onClick={() => state.set({ findOpen: false, query: '', hits: [] })}
                >
                  <X size={14} />
                </IconButton>
              </div>
            )}
          </div>
          {state.inspector && (
            <aside className="inspector">
              <h2>Inspector</h2>
              {host.ctx.selection.get().length ? (
                host.ctx.selection.get().map((item) => {
                  const Component = host.inspectors.get(item.kind);
                  return Component ? (
                    <Component key={item.id} selection={[item]} />
                  ) : (
                    <div key={item.id}>
                      <p>{item.kind}</p>
                      <p className="muted">
                        {Math.round(item.bounds[2] - item.bounds[0])} ×{' '}
                        {Math.round(item.bounds[3] - item.bounds[1])} pt
                      </p>
                    </div>
                  );
                })
              ) : (
                <EmptyState>Select an object to see its properties.</EmptyState>
              )}
              {[...host.panels.right.values()].map((p) => (
                <p.component key={p.id} />
              ))}
            </aside>
          )}
        </div>
      ) : (
        <main className="start" data-testid="start-screen">
          <section className="start-intro">
            <img className="start-mark" src={appMark} alt="" />
            <h1>
              Your documents.
              <br />
              <span className="start-accent">Your workspace.</span>
            </h1>
            <p>Read, arrange and work with your PDFs. Everything stays on your computer.</p>
            <Button className="primary open-primary" onClick={() => execute('view.open')}>
              <FolderOpen size={17} />
              Open files<span className="shortcut">{keys('Ctrl+O')}</span>
            </Button>
            <div className="start-actions">
              <Button
                onClick={() =>
                  host.commands.has('organize.combine')
                    ? execute('organize.combine')
                    : toast('Combine files will be added by the Organize package.')
                }
              >
                <FilePlus2 size={16} />
                Combine files
              </Button>
              <Button
                onClick={() =>
                  execute(
                    host.commands.has('export.imagesToPdf') ? 'export.imagesToPdf' : 'view.open',
                  )
                }
              >
                <FileImage size={16} />
                Create PDF from images
              </Button>
            </div>
            <div className="start-footer">
              <ShieldCheck size={14} />
              Offline by design. No account needed.
            </div>
          </section>
          <section className="recent-section">
            <div className="recent-heading">
              <h2>Recent documents</h2>
              <span>On this computer</span>
            </div>
            {!recent.length && (
              <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
                No recent documents yet.
              </p>
            )}
            {recent.slice(0, 5).map((file) => (
              <button
                className="recent-file"
                key={file.handle}
                onClick={() => void openFiles([file])}
              >
                {file.thumbnail ? <img src={file.thumbnail} alt="" /> : <FileText size={25} />}
                <div>
                  <span>{file.name}</span>
                  <small>
                    {new Date(file.lastOpened).toLocaleDateString()} ·{' '}
                    {Math.max(1, Math.round(file.size / 1024))} KB
                  </small>
                </div>
                <ChevronRight size={15} />
              </button>
            ))}
            <div className="drop-zone">
              <Upload size={24} />
              <span>Drop PDFs or images here</span>
              <span className="muted">Or choose a file to get started</span>
            </div>
          </section>
        </main>
      )}
      <footer className="statusbar">
        <div>
          {tab ? (
            <>
              <IconButton
                label="Previous page"
                disabled={tab.page === 0}
                onClick={() => state.updateTab(tab.info.docId, { page: tab.page - 1 })}
              >
                <ChevronLeft size={13} />
              </IconButton>
              <label>
                Page{' '}
                <input
                  aria-label="Page number"
                  type="number"
                  min={1}
                  max={tab.info.pageCount}
                  value={tab.page + 1}
                  onChange={(e) => {
                    const page = Number(e.target.value) - 1;
                    if (page >= 0 && page < tab.info.pageCount)
                      state.updateTab(tab.info.docId, { page });
                  }}
                />{' '}
                of {tab.info.pageCount}
              </label>
              <IconButton
                label="Next page"
                disabled={tab.page === tab.info.pageCount - 1}
                onClick={() => state.updateTab(tab.info.docId, { page: tab.page + 1 })}
              >
                <ChevronRight size={13} />
              </IconButton>
              <span>
                {activePage &&
                  `${Math.round(activePage.width)} × ${Math.round(activePage.height)} pt`}
              </span>
            </>
          ) : (
            <span>Ready</span>
          )}
        </div>
        <div>
          {tab && (
            <>
              <span>{tab.layout.replace('-', ' ')}</span>
              <span className={`save-state ${tab.info.dirty ? 'unsaved' : ''}`}>
                {tab.info.dirty ? 'Unsaved changes' : 'All changes saved'}
              </span>
            </>
          )}
          <ShieldCheck size={12} className="local-mark" />
          <span>Local workspace</span>
        </div>
      </footer>
      {settingsOpen && (
        <Dialog title="Settings" onClose={() => setSettingsOpen(false)}>
          <label className="field">
            Appearance
            <select
              aria-label="Theme"
              value={state.settings.theme}
              onChange={(e) =>
                void host.ctx.settings.set({ theme: e.target.value as typeof state.settings.theme })
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </label>
          <label className="field">
            Default zoom
            <select
              value={state.settings.defaultZoom}
              onChange={(e) =>
                void host.ctx.settings.set({
                  defaultZoom: e.target.value as 'fit-width' | 'fit-page' | 'actual',
                })
              }
            >
              <option value="fit-width">Fit width</option>
              <option value="fit-page">Fit page</option>
              <option value="actual">Actual size</option>
            </select>
          </label>
          <label className="field">
            Author name
            <input
              value={state.settings.authorName}
              onChange={(e) => void host.ctx.settings.set({ authorName: e.target.value })}
            />
          </label>
          <label className="field">
            Recovery interval (seconds)
            <input
              type="number"
              min={10}
              max={3600}
              value={state.settings.recoveryIntervalSeconds}
              onChange={(e) =>
                void host.ctx.settings.set({
                  recoveryIntervalSeconds: Math.max(10, Number(e.target.value)),
                })
              }
            />
          </label>
          <label className="field">
            Enable PDF JavaScript
            <input
              type="checkbox"
              checked={state.settings.enableJavaScript}
              onChange={(e) => void host.ctx.settings.set({ enableJavaScript: e.target.checked })}
            />
          </label>
          <p className="settings-help">Scripts inside PDF files are switched off by default.</p>
          <About />
        </Dialog>
      )}
      {aboutOpen && (
        <Dialog title="About Garnet PDF" onClose={() => setAboutOpen(false)}>
          <div className="about-only">
            <About />
          </div>
        </Dialog>
      )}
      {palette && (
        <Dialog title="Commands" onClose={() => setPalette(false)}>
          <input
            className="palette-input"
            aria-label="Search commands"
            placeholder="Search commands..."
            value={paletteQuery}
            onChange={(e) => setPaletteQuery(e.target.value)}
          />
          <div className="palette-results">
            {[...host.commands.values()]
              .filter((c) => c.title.toLowerCase().includes(paletteQuery.toLowerCase()))
              .map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setPalette(false);
                    execute(c.id);
                  }}
                >
                  {c.icon ? <c.icon size={16} /> : <ListFilter size={16} />}
                  <span>{c.title}</span>
                  <span className="shortcut">{c.shortcut && keys(c.shortcut)}</span>
                </button>
              ))}
          </div>
        </Dialog>
      )}
      {recoveries.length > 0 && (
        <Dialog title="Restore recovered documents?" onClose={() => setRecoveries([])}>
          <p>These local snapshots contain changes from an earlier session.</p>
          {recoveries.map((entry) => (
            <div className="field" key={entry.id}>
              <span>{entry.name}</span>
              <Button
                onClick={() =>
                  void restoreRecovery(entry).then(() =>
                    setRecoveries((r) => r.filter((x) => x.id !== entry.id)),
                  )
                }
              >
                Restore
              </Button>
            </div>
          ))}
          <footer>
            <Button onClick={() => setRecoveries([])}>Later</Button>
          </footer>
        </Dialog>
      )}
      {printing && (
        <Dialog
          title="Preparing print"
          onClose={() => {
            printCancel.current = true;
            setPrinting(null);
          }}
        >
          <div className="print-progress">
            Page {printing.page} of {printing.total}
            <Button
              onClick={() => {
                printCancel.current = true;
                setPrinting(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </Dialog>
      )}
      {ui.request && <RequestDialog key={ui.request.title} request={ui.request} />}
      {ui.toast && (
        <div className="toast-stack">
          <Toast>{ui.toast}</Toast>
        </div>
      )}
    </div>
  );
}
function Outline({ items, onPage }: { items: OutlineItem[]; onPage: (page: number) => void }) {
  if (!items.length) return <EmptyState>No bookmarks in this document.</EmptyState>;
  return (
    <>
      {items.map((item, i) => (
        <div key={i}>
          <button
            className="bookmark-item"
            onClick={() => {
              if (item.page !== undefined) onPage(Math.max(0, item.page));
              else if (item.uri) void window.garnet.openExternal(item.uri);
            }}
          >
            <Bookmark size={13} />
            {item.title}
          </button>
          {item.children && (
            <div style={{ paddingLeft: 12 }}>
              <Outline items={item.children} onPage={onPage} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
function RequestDialog({
  request,
}: {
  request: NonNullable<ReturnType<typeof useUI.getState>['request']>;
}) {
  const [value, setValue] = useState(request.initial || '');
  const finish = (v: string | null) => {
    useUI.getState().set({ request: null });
    request.resolve(v);
  };
  return (
    <Dialog title={request.title} onClose={() => finish(null)}>
      {request.kind === 'prompt' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            finish(value);
          }}
        >
          <input
            style={{ width: '100%' }}
            aria-label={request.title}
            type={/password/i.test(request.title) ? 'password' : 'text'}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <footer>
            <Button type="button" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button className="primary" type="submit">
              Continue
            </Button>
          </footer>
        </form>
      ) : request.kind === 'print' ? (
        <PrintOptionsForm total={Number(request.initial)} finish={finish} />
      ) : request.kind === 'encryption' ? (
        <>
          <p>
            Choose how to protect the saved file. Keeping protection needs the existing passwords.
          </p>
          <footer>
            <Button onClick={() => finish(null)}>Cancel</Button>
            <Button onClick={() => finish('remove')}>Remove protection</Button>
            <Button onClick={() => finish('set')}>Set new password</Button>
            <Button
              className="primary"
              disabled={request.initial === 'recovery'}
              onClick={() => finish('keep')}
            >
              Keep protection
            </Button>
          </footer>
        </>
      ) : request.kind === 'close' ? (
        <>
          <p>Your changes have not been saved.</p>
          <footer>
            <Button onClick={() => finish(null)}>Cancel</Button>
            <Button onClick={() => finish('discard')}>Don't save</Button>
            <Button className="primary" onClick={() => finish('save')}>
              Save
            </Button>
          </footer>
        </>
      ) : request.kind === 'confirm' ? (
        <footer>
          <Button onClick={() => finish(null)}>Cancel</Button>
          <Button className="primary" onClick={() => finish('yes')}>
            Continue
          </Button>
        </footer>
      ) : (
        <>
          {request.content}
          <footer>
            <Button onClick={() => finish('yes')}>Close</Button>
          </footer>
        </>
      )}
    </Dialog>
  );
}

function PrintOptionsForm({
  total,
  finish,
}: {
  total: number;
  finish: (value: string | null) => void;
}) {
  const [range, setRange] = useState(`1-${total}`),
    [copies, setCopies] = useState(1),
    [grayscale, setGrayscale] = useState(false),
    [sizing, setSizing] = useState<'fit' | 'actual'>('fit');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        finish(JSON.stringify({ range, copies, grayscale, sizing }));
      }}
    >
      <label className="field">
        Pages
        <input aria-label="Print pages" value={range} onChange={(e) => setRange(e.target.value)} />
      </label>
      <label className="field">
        Copies
        <input
          aria-label="Copies"
          type="number"
          min={1}
          max={999}
          value={copies}
          onChange={(e) => setCopies(Number(e.target.value))}
        />
      </label>
      <label className="field">
        Page sizing
        <select
          aria-label="Page sizing"
          value={sizing}
          onChange={(e) => setSizing(e.target.value as 'fit' | 'actual')}
        >
          <option value="fit">Fit to printer paper</option>
          <option value="actual">Actual size</option>
        </select>
      </label>
      <label className="field">
        Grayscale
        <input
          type="checkbox"
          checked={grayscale}
          onChange={(e) => setGrayscale(e.target.checked)}
        />
      </label>
      <p className="settings-help">
        Choose your printer, duplex and other options in the system print dialog.
      </p>
      <footer>
        <Button type="button" onClick={() => finish(null)}>
          Cancel
        </Button>
        <Button className="primary" type="submit">
          Continue to print
        </Button>
      </footer>
    </form>
  );
}
