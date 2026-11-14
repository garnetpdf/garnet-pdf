import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { FileStore } from './file-store';
import { FontStore } from './fonts';
import { BackupStore } from './backups';
import { SaveError, saveAtomically } from './atomic-save';
import { verifyPdf } from './verify-pdf';
import { assertIpcSender, parseIpcPayload } from './ipc-security';
import { printPageLayout } from './print-layout';
import { saveFilesSchema, saveFilesToFolder } from './page-files';
import { registerSignStore } from './ipc/sign-store';
import { registerP4bIpc } from './ipc/p4b-files';
import { applyMenu } from './menu';
import { APP_NAME, nameForKeychain, reportedPlatform, windowChrome } from './platform';
import { smokeEnvironment } from './smoke';
import { emptyMenuState, WEBSITE, type MenuState } from '../shared/menu';
import type {
  FileDescriptor,
  PrintOptions,
  PrintRequest,
  SaveRequest,
  SmokeResult,
} from '../shared/ipc';

const SCHEME = 'app';
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'";
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Garnet PDF never uses the internet. Pages are stopped by session.webRequest below, but Chromium
// has parts of its own that go out without passing through it: on first start the spelling checker
// fetched its dictionary from Google. With these switches no host name can be looked up at all, so
// no request of any kind can leave the computer. tests/e2e/offline.spec.ts reads Chromium's own
// network log to prove it.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
app.commandLine.appendSwitch('disable-background-networking');
// No proxy either. With "detect settings automatically" on (the Windows default) Chromium asks the
// local network for a proxy script at start; an application that makes no requests needs none.
app.commandLine.appendSwitch('no-proxy-server');

const rendererRoot = join(__dirname, '../renderer');
let mainWindow: BrowserWindow | null = null;
let fileStore: FileStore;
let fontStore: FontStore;
let backups: BackupStore;
let closeAllowed = false;
let rendererReady = false;
// Set once the file store and the window bridge exist: a window can be opened from then on.
let started = false;
let opening: Promise<void> | null = null;
// Quit was chosen (Cmd+Q on a Mac). The window still asks about unsaved changes first.
let quitting = false;
let quitAfterClose = false;
let menuState: MenuState = emptyMenuState;
const pendingCommands: string[] = [];
const pendingPaths: string[] = [];
const networkAttempts: string[] = [];
const allRequests: string[] = [];
const saveQueues = new Map<string, Promise<unknown>>();
const smokeIndex = process.argv.indexOf('--smoke-test');
const smokeInput = smokeIndex >= 0 ? process.argv[smokeIndex + 1] : undefined;
const smokeOutput = smokeIndex >= 0 ? process.argv[smokeIndex + 2] : undefined;
const smokeMode = Boolean(smokeInput && smokeOutput);
const servedPrint = new Map<string, string>();
const printJobs = new Map<
  string,
  { window: BrowserWindow; options: PrintOptions; count: number }
>();

function pathsFromArgv(argv: string[]): string[] {
  return argv.filter(
    (value) =>
      isAbsolute(value) &&
      ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'].includes(
        extname(value).toLowerCase(),
      ),
  );
}
if (!smokeMode) pendingPaths.push(...pathsFromArgv(process.argv));
nameForKeychain(app);
if (!app.requestSingleInstanceLock()) app.quit();
else
  app.on('second-instance', (_event, argv) => {
    pendingPaths.push(...pathsFromArgv(argv));
    showWindow();
    void deliverPending();
  });
// A Mac sends this for a file double-clicked in Finder, dropped on the Dock icon or chosen with
// "Open With": before the app is ready (the file waits for the window to start), while a window is
// open (the file opens in a tab), and after the window was closed (a new window opens for it).
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (smokeMode) return;
  pendingPaths.push(path);
  showWindow();
  void deliverPending();
});

function mime(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    (
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
      } as Record<string, string>
    )[extension] || 'application/octet-stream'
  );
}

function installProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'print') {
      const token = url.pathname.slice(1);
      const html = servedPrint.get(token);
      if (!html)
        return new Response('Not found', {
          status: 404,
          headers: { 'Content-Security-Policy': CSP },
        });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP },
      });
    }
    if (url.hostname !== 'renderer') return new Response('Not found', { status: 404 });
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    if (pathname.includes('\0') || pathname.split('/').includes('..'))
      return new Response('Forbidden', { status: 403 });
    const path = resolve(rendererRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    const inside = relative(rendererRoot, path);
    if (inside.startsWith('..') || isAbsolute(inside))
      return new Response('Forbidden', { status: 403 });
    try {
      const file = await readFile(path);
      return new Response(file, {
        headers: {
          'Content-Type': mime(path),
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function deliverPending(): Promise<void> {
  if (!rendererReady || !mainWindow || mainWindow.webContents.isLoading() || !pendingPaths.length)
    return;
  const paths = pendingPaths.splice(0);
  const descriptors: FileDescriptor[] = [];
  for (const path of paths) {
    try {
      const descriptor = await fileStore.descriptor(path);
      await rememberRecent(descriptor.handle);
      descriptors.push(descriptor);
    } catch {
      /* The requested file may have moved. */
    }
  }
  if (descriptors.length) mainWindow?.webContents.send('garnet:open-files', descriptors);
}

/** Notes a file as recently opened: in the app's own list and, on a Mac, in File > Open Recent and the Dock. */
async function rememberRecent(handle: string): Promise<void> {
  await fileStore.touchRecent(handle);
  if (process.platform === 'darwin') app.addRecentDocument(fileStore.path(handle));
}

/** Brings the window forward, or opens one when there is none (on a Mac the app stays in the Dock). */
function showWindow(): void {
  if (smokeMode) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (started)
    opening ??= createWindow()
      .catch((error) => console.error(error))
      .finally(() => {
        opening = null;
      });
}

/** A command chosen in the menu bar, passed to the window (opening one first if there is none). */
function sendMenuCommand(command: string): void {
  if (mainWindow && rendererReady) {
    mainWindow.webContents.send('garnet:menu-command', command);
    return;
  }
  pendingCommands.push(command);
  showWindow();
}

function refreshMenu(): void {
  applyMenu({
    platform: process.platform,
    packaged: app.isPackaged,
    appName: APP_NAME,
    state: menuState,
    send: sendMenuCommand,
    openWebsite: () => void shell.openExternal(WEBSITE),
  });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 820,
    minHeight: 600,
    show: !smokeMode,
    backgroundColor: '#f7f8fa',
    title: APP_NAME,
    ...windowChrome(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow = window;
  closeAllowed = false;
  quitAfterClose = false;
  fileStore.setOwner(window.webContents.id);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('did-finish-load', () => void deliverPending());
  window.on('close', (event) => {
    if (!closeAllowed && !smokeMode) {
      event.preventDefault();
      // The window asks about unsaved changes, then closes; if Quit was chosen the app quits after.
      quitAfterClose = quitting;
      quitting = false;
      window.webContents.send('garnet:close-requested');
    }
  });
  window.on('enter-full-screen', () => window.webContents.send('garnet:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('garnet:fullscreen', false));
  window.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
  await window.loadURL('app://renderer/index.html');
}

function assertSender(event: Electron.IpcMainInvokeEvent): void {
  assertIpcSender(
    event.sender.id,
    mainWindow?.webContents.id,
    event.senderFrame?.url,
    event.senderFrame === mainWindow?.webContents.mainFrame,
  );
}
function handle<T extends z.ZodTypeAny>(
  channel: string,
  schema: T,
  run: (value: z.infer<T>, event: Electron.IpcMainInvokeEvent) => Promise<unknown> | unknown,
): void {
  ipcMain.handle(`garnet:${channel}`, (event, value) => {
    assertSender(event);
    return run(parseIpcPayload(schema, value), event);
  });
}
const empty = z.undefined();
const handleId = z.string().uuid();
const buffer = z.instanceof(ArrayBuffer);
const saveSchema = z.object({
  handle: handleId.optional(),
  bytes: buffer,
  expectedPageCount: z.number().int().nonnegative(),
  saveAs: z.boolean().optional(),
  suggestedName: z.string().max(250).optional(),
  hasSignatures: z.boolean().optional(),
  redactionApplied: z.boolean().optional(),
  recoveryId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .optional(),
  savedRevision: z.number().int().nonnegative().optional(),
  verificationPassword: z.string().max(1024).optional(),
});
const printOptionsSchema = z.object({
  copies: z.number().int().min(1).max(99).optional(),
  landscape: z.boolean().optional(),
  grayscale: z.boolean().optional(),
  sizing: z.enum(['fit', 'actual']).optional(),
});
const printPageSchema = z.object({
  png: buffer.refine((value) => value.byteLength <= 100_000_000, 'Print page is too large.'),
  width: z.number().positive(),
  height: z.number().positive(),
});

async function queueSave<T>(path: string, job: () => Promise<T>): Promise<T> {
  const prior = saveQueues.get(path) || Promise.resolve();
  const current = prior.catch(() => undefined).then(job);
  saveQueues.set(path, current);
  try {
    return await current;
  } finally {
    if (saveQueues.get(path) === current) saveQueues.delete(path);
  }
}

async function saveFile(request: SaveRequest): Promise<FileDescriptor | null> {
  let target: string | undefined;
  const existingHandle = request.handle;
  let saveAs = request.saveAs || request.hasSignatures || !existingHandle;
  let overwriteApproved = false;
  if (!saveAs && existingHandle) {
    target = fileStore.path(existingHandle);
    if (await fileStore.changedSinceOpen(existingHandle)) {
      const choice = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Save As', 'Overwrite', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'This file changed outside Garnet PDF.',
        detail: 'Choose where to save your changes.',
      });
      if (choice.response === 2) return null;
      if (choice.response === 0) saveAs = true;
      else overwriteApproved = true;
    }
  }
  if (saveAs) {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save PDF As',
      defaultPath:
        request.suggestedName || (existingHandle ? fileStore.path(existingHandle) : 'Untitled.pdf'),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  if (!target) throw new Error('No destination file was selected.');
  const path = target;
  return queueSave(path, async () => {
    if (
      !saveAs &&
      existingHandle &&
      !overwriteApproved &&
      (await fileStore.changedSinceOpen(existingHandle))
    )
      throw new Error('The file changed again while saving. Use Save As or retry.');
    const expectedFingerprint = await fileStore.fingerprintAtPath(path);
    const bytes = new Uint8Array(request.bytes);
    // Backup is written before replacement, so a failed backup cannot leave a successful save unprotected.
    if (!request.redactionApplied) await backups.retainPrevious(path);
    await saveAtomically(
      path,
      bytes,
      (data) => verifyPdf(data, request.expectedPageCount, request.verificationPassword),
      {
        beforeRename: async () => {
          const current = await fileStore.fingerprintAtPath(path);
          if (!FileStore.sameFingerprint(expectedFingerprint, current))
            throw new SaveError(
              'The destination changed during save. The original is unchanged. Use Save As or retry.',
            );
        },
      },
    );
    const descriptor = await fileStore.descriptor(path);
    await fileStore.refreshFingerprint(descriptor.handle);
    await rememberRecent(descriptor.handle);
    if (request.redactionApplied) {
      await backups.purge(path);
      if (request.recoveryId) await fileStore.deleteRecovery(request.recoveryId);
    } else if (request.recoveryId && request.savedRevision !== undefined)
      await fileStore.deleteRecoveryUpTo(request.recoveryId, request.savedRevision);
    return descriptor;
  }).catch(async (error: unknown) => {
    if (
      saveAs ||
      !(error instanceof SaveError) ||
      !/read-only|locked|cannot be written/.test(error.message)
    )
      throw error;
    const choice = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Save As', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'This file cannot be replaced.',
      detail: error.message,
    });
    return choice.response === 0 ? saveFile({ ...request, saveAs: true }) : null;
  });
}

async function beginPrint(options: PrintOptions = {}): Promise<string> {
  const token = randomUUID();
  servedPrint.set(
    token,
    '<!doctype html><meta charset="utf-8"><style>body{margin:0}section{break-after:page;overflow:hidden}img{display:block;width:100%;height:100%}</style><body></body>',
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  try {
    await window.loadURL(`app://print/${token}`);
    printJobs.set(token, { window, options, count: 0 });
    return token;
  } catch (error) {
    window.destroy();
    servedPrint.delete(token);
    throw error;
  }
}
async function addPrintPage(token: string, page: PrintRequest['pages'][number]): Promise<void> {
  const job = printJobs.get(token);
  if (!job) throw new Error('Print job is no longer available.');
  if (job.count >= 500) throw new Error('Print job is limited to 500 pages.');
  const bytes = Buffer.from(page.png);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Print page is not a PNG image.');
  const index = job.count++;
  const layout = printPageLayout(index, page.width, page.height, job.options.sizing);
  const css = layout.pageRule;
  const src = `data:image/png;base64,${bytes.toString('base64')}`;
  await job.window.webContents.executeJavaScript(`
    (() => {
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);
      const section = document.createElement('section'); section.style.page = ${JSON.stringify(`page${index}`)};
      section.style.width = ${JSON.stringify(layout.sectionWidth)}; section.style.height = ${JSON.stringify(layout.sectionHeight)};
      const img = document.createElement('img'); img.src = ${JSON.stringify(src)}; img.alt = 'PDF page';
      img.style.objectFit = ${JSON.stringify(layout.imageFit)};
      if (${JSON.stringify(job.options.sizing === 'fit')}) {
        img.style.width = 'auto'; img.style.height = 'auto';
        img.style.maxWidth = '100%'; img.style.maxHeight = '100vh';
      }
      img.style.filter = ${JSON.stringify(job.options.grayscale ? 'grayscale(1)' : '')};
      section.append(img); document.body.append(section);
      return new Promise((resolve, reject) => { if (img.complete) resolve(true); else { img.onload = () => resolve(true); img.onerror = () => reject(new Error('Print image failed to load.')); } });
    })()
  `);
}
async function finishPrint(token: string): Promise<void> {
  const job = printJobs.get(token);
  if (!job) throw new Error('Print job is no longer available.');
  if (!job.count) throw new Error('Choose at least one page to print.');
  try {
    await new Promise<void>((resolve, reject) =>
      job.window.webContents.print(
        {
          silent: false,
          printBackground: true,
          copies: job.options.copies || 1,
          landscape: Boolean(job.options.landscape),
          ...(job.options.sizing === 'fit'
            ? { usePrinterDefaultPageSize: true }
            : { scaleFactor: 100 }),
        },
        (success, reason) =>
          success ? resolve() : reject(new Error(reason || 'Print was cancelled.')),
      ),
    );
  } finally {
    await cancelPrint(token);
  }
}
async function cancelPrint(token: string): Promise<void> {
  const job = printJobs.get(token);
  if (job) {
    job.window.destroy();
    printJobs.delete(token);
  }
  servedPrint.delete(token);
}
async function printPages(request: PrintRequest): Promise<void> {
  const token = await beginPrint(request);
  try {
    for (const page of request.pages) await addPrintPage(token, page);
    await finishPrint(token);
  } catch (error) {
    await cancelPrint(token);
    throw error;
  }
}

function registerIpc(): void {
  registerP4bIpc(handle, () => mainWindow);
  handle('open-dialog', empty, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'PDF and images',
          extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'],
        },
      ],
    });
    if (result.canceled) return [];
    const files = await Promise.all(result.filePaths.map((path) => fileStore.descriptor(path)));
    await Promise.all(files.map((file) => rememberRecent(file.handle)));
    return files;
  });
  handle('register-drop', z.string().min(1), async (path) => {
    const file = await fileStore.descriptor(path);
    await rememberRecent(file.handle);
    return file;
  });
  handle('read-file', handleId, (handle) => fileStore.bytes(handle));
  handle('save-file', saveSchema, (value) => saveFile(value));
  handle('save-files', saveFilesSchema, (value) =>
    saveFilesToFolder(mainWindow!, fileStore, value),
  );
  handle('recent-list', empty, () => fileStore.recent());
  handle('recent-thumbnail', z.object({ handle: handleId, png: buffer }), (value) =>
    fileStore.setThumbnail(value.handle, value.png),
  );
  handle(
    'recent-view',
    z
      .object({
        handle: handleId,
        state: z
          .object({
            page: z.number().int().nonnegative(),
            zoom: z.number().min(0.1).max(64),
            fit: z.enum(['width', 'page']).optional(),
            rotation: z
              .number()
              .int()
              .refine((value) => [0, 90, 180, 270].includes(value)),
            layout: z.enum(['continuous', 'single', 'two-page', 'cover']),
          })
          .strict(),
      })
      .strict(),
    (value) => fileStore.setView(value.handle, value.state),
  );
  handle('recent-remove', handleId, (value) => fileStore.removeRecent(value));
  handle('settings-get', empty, () => fileStore.settings());
  handle(
    'settings-set',
    z
      .object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
        defaultZoom: z
          .union([z.enum(['fit-width', 'fit-page', 'actual']), z.number().min(0.1).max(64)])
          .optional(),
        authorName: z.string().max(150).optional(),
        enableJavaScript: z.boolean().optional(),
        recoveryIntervalSeconds: z.number().int().min(15).max(3600).optional(),
      })
      .strict(),
    (value) => fileStore.setSettings(value),
  );
  handle('recovery-list', empty, () => fileStore.recoveryEntries());
  handle(
    'recovery-write',
    z.object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      name: z.string().max(250),
      originalHandle: handleId.optional(),
      bytes: buffer,
      revision: z.number().int().nonnegative().optional(),
      encrypted: z.boolean().optional(),
    }),
    (value) =>
      fileStore.writeRecovery(
        value.id,
        value.name,
        value.originalHandle,
        value.bytes,
        value.revision,
        value.encrypted,
      ),
  );
  handle('recovery-read', z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), (id) =>
    fileStore.readRecovery(id),
  );
  handle('recovery-delete', z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), (id) =>
    fileStore.deleteRecovery(id),
  );
  handle('fonts-list', empty, () => fontStore.list());
  handle('fonts-read', handleId, (handle) => fontStore.read(handle));
  handle(
    'print',
    printOptionsSchema.extend({ pages: z.array(printPageSchema).min(1).max(500) }),
    (value) => printPages(value),
  );
  handle('print-begin', printOptionsSchema, (value) => beginPrint(value));
  handle('print-add-page', z.object({ id: handleId, page: printPageSchema }), (value) =>
    addPrintPage(value.id, value.page),
  );
  handle('print-finish', handleId, (id) => finishPrint(id));
  handle('print-cancel', handleId, (id) => cancelPrint(id));
  handle('reveal', handleId, async (handle) => {
    shell.showItemInFolder(fileStore.path(handle));
  });
  handle('open-external', z.string().url(), async (url) => {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol))
      throw new Error('This link type is not allowed.');
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['Open link', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Open this link in your browser?',
      detail: url,
    });
    if (result.response !== 0) return false;
    await shell.openExternal(url);
    return true;
  });
  handle('window-minimize', empty, () => mainWindow!.minimize());
  handle('window-maximize', empty, () =>
    mainWindow!.isMaximized() ? mainWindow!.unmaximize() : mainWindow!.maximize(),
  );
  handle('window-close', empty, () => {
    closeAllowed = true;
    if (quitAfterClose) app.quit();
    else mainWindow!.close();
  });
  handle('window-fullscreen', z.boolean(), (value) => mainWindow!.setFullScreen(value));
  handle('window-is-maximized', empty, () => mainWindow!.isMaximized());
  handle('startup', empty, async () => {
    const files: FileDescriptor[] = [];
    if (smokeMode && smokeInput) files.push(await fileStore.descriptor(resolve(smokeInput)));
    for (const path of pendingPaths.splice(0)) {
      try {
        files.push(await fileStore.descriptor(path));
      } catch {
        /* Ignore files removed before launch. */
      }
    }
    await Promise.all(files.map((file) => rememberRecent(file.handle)));
    rendererReady = true;
    // Commands chosen in the menu bar while no window was open run once this answer has arrived.
    setTimeout(() => pendingCommands.splice(0).forEach(sendMenuCommand), 0);
    return { files, smoke: smokeMode, platform: reportedPlatform(app.isPackaged) };
  });
  handle(
    'menu-state',
    z
      .object({
        hasDocument: z.boolean(),
        mode: z.string().max(60),
        modes: z.array(z.string().max(60)).max(40),
      })
      .strict(),
    (value) => {
      menuState = value;
      // Only the Mac menu bar shows the state; the hidden menu of Windows and Linux never changes.
      if (process.platform === 'darwin') refreshMenu();
    },
  );
  handle('smoke-request', empty, async () =>
    smokeMode && smokeInput ? { input: await fileStore.descriptor(resolve(smokeInput)) } : null,
  );
  handle(
    'smoke-save',
    z.object({ bytes: buffer, expectedPageCount: z.number().int().nonnegative() }),
    async (value) => {
      if (!smokeMode || !smokeOutput) throw new Error('Smoke mode is not active.');
      const path = join(dirname(resolve(smokeOutput)), `garnet-smoke-${randomUUID()}.pdf`);
      await saveAtomically(path, new Uint8Array(value.bytes), (bytes) =>
        verifyPdf(bytes, value.expectedPageCount),
      );
      return fileStore.descriptor(path);
    },
  );
  handle(
    'smoke-complete',
    z.object({
      checks: z.record(z.string(), z.boolean()),
      error: z.string().optional(),
      timings: z.record(z.string(), z.number()).optional(),
    }),
    async (value) => {
      if (!smokeMode || !smokeOutput) throw new Error('Smoke mode is not active.');
      const result = value as SmokeResult;
      // The eleven checks come from the window; facts about this machine and its data folder are added here.
      const environment = await smokeEnvironment(fileStore).catch((error) => ({
        error: String(error),
      }));
      const data = Buffer.from(JSON.stringify({ ...result, environment }, null, 2));
      await saveAtomically(resolve(smokeOutput), data, (candidate) => {
        JSON.parse(Buffer.from(candidate).toString());
      });
      process.exitCode = !result.error && Object.values(result.checks).every(Boolean) ? 0 : 1;
      setTimeout(() => {
        closeAllowed = true;
        app.quit();
      }, 100);
    },
  );
  handle('diagnostics-network-attempts', empty, () => [...networkAttempts]);
  handle('diagnostics-all-requests', empty, () => [...allRequests]);
  handle('app-info', empty, () => ({ packaged: app.isPackaged, version: app.getVersion() }));
  registerSignStore(handle);
}

app
  .whenReady()
  .then(async () => {
    // First of all, before any window exists: no spelling checker and no language for it, so it
    // never asks for a dictionary. (Electron puts the system language back at every start, so this
    // has to run every time.)
    const ses = session.defaultSession;
    ses.setSpellCheckerLanguages([]);
    ses.setSpellCheckerEnabled(false);
    fileStore = new FileStore(app.getPath('userData'));
    fontStore = new FontStore();
    backups = new BackupStore(join(app.getPath('userData'), 'backups'));
    installProtocol();
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*', 'app://*/*'] }, (details, callback) => {
      allRequests.push(details.url);
      if (!/^https?:/.test(details.url)) return callback({ cancel: false });
      networkAttempts.push(details.url);
      callback({ cancel: true });
    });
    registerIpc();
    refreshMenu();
    started = true;
    await createWindow();
  })
  .catch(async (error) => {
    if (smokeOutput) {
      const result = Buffer.from(JSON.stringify({ checks: {}, error: String(error) }, null, 2));
      await saveAtomically(resolve(smokeOutput), result, (candidate) => {
        JSON.parse(Buffer.from(candidate).toString());
      }).catch(() => undefined);
    }
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });

app.on('before-quit', () => {
  quitting = true;
});
// On a Mac the app stays in the Dock when its window is closed, and a click on the Dock icon opens a
// new window. Everywhere else closing the window ends the app.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting || smokeMode) app.quit();
});
app.on('activate', () => showWindow());
