/** PDF Standard security handler permission bits (ISO 32000-2, Table 22). */
export const PERMISSION_KEYS = ['print', 'copy', 'edit', 'annotate', 'form', 'accessibility', 'assemble', 'printHighQuality'] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type Permissions = Record<PermissionKey, boolean>;

const BITS: Record<PermissionKey, number> = {
  print: 1 << 2,
  edit: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  form: 1 << 8,
  accessibility: 1 << 9,
  assemble: 1 << 10,
  printHighQuality: 1 << 11,
};

/** Reserved bits 7-8 and 13-32 must be 1, bits 1-2 must be 0 (as a signed 32-bit integer). */
const RESERVED = ~0 & ~0b111111111111 | 0b11000000;

export const ALL_PERMISSIONS: Permissions = Object.fromEntries(PERMISSION_KEYS.map(key => [key, true])) as Permissions;

export function permissionsToP(permissions: Permissions): number {
  let p = RESERVED;
  for (const key of PERMISSION_KEYS) if (permissions[key]) p |= BITS[key];
  return p | 0;
}

export function pToPermissions(p: number | null | undefined): Permissions {
  if (p === null || p === undefined) return { ...ALL_PERMISSIONS };
  return Object.fromEntries(PERMISSION_KEYS.map(key => [key, (p & BITS[key]) !== 0])) as Permissions;
}

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  print: 'Print',
  printHighQuality: 'Print at high quality',
  copy: 'Copy text and images',
  edit: 'Edit page content',
  annotate: 'Add comments',
  form: 'Fill in forms',
  assemble: 'Insert, delete and rotate pages',
  accessibility: 'Screen reader access',
};

/** A password the PDF security handler can store: printable, no control characters, at most 127 bytes in UTF-8. */
export function passwordProblem(password: string): string | null {
  if ([...password].some(character => {
    const code = character.codePointAt(0) || 0;
    return code < 32 || code === 127;
  })) return 'Passwords cannot contain line breaks or control characters.';
  if (new TextEncoder().encode(password).length > 127) return 'Use a password shorter than 128 bytes.';
  return null;
}
