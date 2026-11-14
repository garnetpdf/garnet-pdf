/**
 * Keyboard hints for the system the app runs on.
 *
 * Shortcuts are written once, the Windows way ("Ctrl+Shift+S"). On a Mac the same shortcut is pressed
 * with Command and is shown with the Mac signs, as in the menu bar.
 */
let mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

/** True on a Mac. */
export const isMac = (): boolean => mac;

/** The system reported by the main process, once it is known. */
export function setPlatform(platform: string): void {
  mac = platform === 'darwin';
}

const POINTER = /^(?:click|drag|wheel|scroll)$/i;
const KEY = String.raw`(?:F\d{1,2}|Enter|Delete|Backspace|Tab|Space|Home|End|Escape|[Cc]lick|[Dd]rag|[Ww]heel|[Ss]croll|[A-Za-z0-9]|[=,\-+.\/\[\]])`;
const MODIFIED = String.raw`(?:(?:Ctrl|Alt|Shift)\+)+${KEY}`;
const WHOLE = new RegExp(`^(?:${MODIFIED}|F11|Enter)$`);
const INSIDE = new RegExp(String.raw`\b${MODIFIED}(?![A-Za-z0-9])`, 'g');
const SIGN: Record<string, string> = { Ctrl: '⌘', Alt: '⌥', Shift: '⇧' };
// Apple's order for the signs before the key.
const ORDER = ['Alt', 'Shift', 'Ctrl'];

/**
 * A shortcut as people should read it here: "Ctrl+Shift+S" stays as it is on Windows and Linux and
 * becomes "⇧⌘S" on a Mac. Text that is not a shortcut comes back unchanged.
 */
export function keys(shortcut: string, onMac: boolean = mac): string {
  if (!onMac || !WHOLE.test(shortcut)) return shortcut;
  // Full screen: F11 belongs to macOS (Show Desktop); the Mac shortcut is Control+Command+F.
  if (shortcut === 'F11') return '⌃⌘F';
  const parts = shortcut.split('+');
  let key = parts.pop() ?? '';
  if (key === '') {
    // "Ctrl++": the key itself is the plus sign.
    key = '+';
    if (parts.at(-1) === '') parts.pop();
  }
  if (key === 'Enter') key = '↩';
  // Zoom in is Command with the plus key, which is the same key as the equals sign.
  if (key === '=') key = '+';
  if (key.length === 1) key = key.toUpperCase();
  const signs = ORDER.filter((name) => parts.includes(name))
    .map((name) => SIGN[name])
    .join('');
  // With the mouse it reads "⌘-click", as Apple writes it.
  return POINTER.test(key) ? `${signs}-${key.toLowerCase()}` : `${signs}${key}`;
}

/** A sentence with the shortcuts inside it put the Mac way: "Undo with Ctrl+Z." gives "Undo with ⌘Z." */
export function hintText(sentence: string, onMac: boolean = mac): string {
  return onMac ? sentence.replace(INSIDE, (found) => keys(found, true)) : sentence;
}

function fix(element: Element): void {
  if (element.classList.contains('shortcut')) {
    const text = element.textContent ?? '';
    const shown = keys(text.trim(), true);
    if (shown !== text.trim()) element.textContent = shown;
  }
  const title = element.getAttribute('title');
  const hint = title && /^(.*)\(([^()]+)\)$/s.exec(title);
  if (hint) {
    const shown = keys(hint[2], true);
    if (shown !== hint[2]) element.setAttribute('title', `${hint[1]}(${shown})`);
  }
}

let watching = false;
/**
 * On a Mac, keeps every shortcut hint in the Mac form, also the ones a plug-in draws by itself:
 * elements with the class `shortcut` and the "(Ctrl+X)" at the end of a tooltip. Nothing else is
 * read or changed, so the text of a document, a file name or a comment is never touched.
 */
export function installShortcutHints(root: Element = document.body): void {
  if (!mac || watching) return;
  watching = true;
  const all = (element: Element) => {
    fix(element);
    element.querySelectorAll('.shortcut,[title]').forEach(fix);
  };
  all(root);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') fix(record.target as Element);
      else if (record.type === 'characterData') {
        if (record.target.parentElement) fix(record.target.parentElement);
      } else {
        if (record.target instanceof Element) fix(record.target);
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) all(node);
        });
      }
    }
  }).observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title'],
  });
}
