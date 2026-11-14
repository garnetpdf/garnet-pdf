import type { BrowserWindowConstructorOptions } from 'electron';

/** The name people see. (The folder for settings keeps the package name on every system.) */
export const APP_NAME = 'Garnet PDF';

/** The parts of Electron's `app` that `nameForKeychain` uses. */
interface NamedApp {
  isPackaged: boolean;
  getPath(name: 'userData'): string;
  setName(name: string): void;
  setPath(name: 'userData', path: string): void;
}

/**
 * On a Mac the key that protects recovery copies of password-protected files is kept in the
 * Keychain, under the app's name followed by "Safe Storage". macOS shows that name to the person
 * when it asks whether the app may use the key, so it has to be the name people know: "Garnet PDF
 * Safe Storage", not the package name. The folder for settings stays exactly where it was.
 *
 * Must run before the app is ready. Windows and Linux are left alone: there the name decides where
 * the settings of the published versions are found. An app run from source is left alone too, so a
 * developer's test run never shares a Keychain item with the installed app.
 */
export function nameForKeychain(app: NamedApp, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin' || !app.isPackaged) return;
  const data = app.getPath('userData');
  app.setName(APP_NAME);
  app.setPath('userData', data);
}

/** Height of the app's own title bar (the strip with the document tabs), in CSS pixels. */
export const TITLE_BAR_HEIGHT = 42;

/**
 * Where the three window buttons of a Mac (close, minimise, zoom) sit inside the title bar.
 * They are 14 pixels tall; this centres them in the strip and keeps the same gap to the left edge.
 */
export const TRAFFIC_LIGHTS = { x: 14, y: (TITLE_BAR_HEIGHT - 14) / 2 };

/**
 * How the window frame is drawn on each system.
 * - Mac: the system's own window buttons stay, inset into the app's title bar. The window keeps its
 *   shadow, rounded corners, full screen and the double-click that zooms or minimises as the user
 *   chose in System Settings.
 * - Windows: the system draws minimise, maximise and close over the right end of the title bar.
 * - Linux: no frame; the app draws its own three buttons.
 */
export function windowChrome(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin')
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { ...TRAFFIC_LIGHTS } };
  if (platform === 'win32')
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#f7f8fa', symbolColor: '#273448', height: 46 },
    };
  return { titleBarStyle: 'hidden', frame: false };
}

/**
 * The system the window is told it runs on. Tests of an app run from source may ask for another one
 * (GARNET_TEST_PLATFORM=darwin) to look at the Mac layout and Mac key hints on a different machine.
 * An installed app always reports the real system.
 */
export function reportedPlatform(
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  actual: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  const asked = env.GARNET_TEST_PLATFORM;
  if (!packaged && (asked === 'darwin' || asked === 'win32' || asked === 'linux')) return asked;
  return actual;
}
