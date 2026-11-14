import type { EngineContext } from '../context';
import type { OpResult } from '../../shared/engine-api';
import { pToPermissions, type Permissions } from '../tools/security/permissions';
import {
  sanitizeDocument,
  type SanitizeCounts,
  type SanitizeOptions,
} from '../tools/security/sanitize';

export interface SecurityStatus {
  encrypted: boolean;
  method: 'aes-256' | 'aes-128' | 'rc4-128' | 'rc4-40' | null;
  permissions: Permissions;
  /** How the document was unlocked when opened. */
  openedWith: 'user' | 'owner' | null;
  /** True when the app may change or remove protection without asking for the owner password. */
  canChangeProtection: boolean;
}

/** When something was removed the result is also the operation result, so the app picks up the change. */
export type SanitizeResult =
  | { changed: false; counts: SanitizeCounts }
  | (OpResult & { changed: true; counts: SanitizeCounts });

declare module '../../shared/engine-api' {
  interface EngineOps {
    'security.status': { args: { docId: string }; result: SecurityStatus };
    'security.checkOwnerPassword': { args: { docId: string; password: string }; result: boolean };
    'security.sanitizeScan': {
      args: { docId: string; options: SanitizeOptions };
      result: SanitizeCounts;
    };
    'security.sanitize': {
      args: { docId: string; options: SanitizeOptions };
      result: SanitizeResult;
    };
  }
}

function status(ctx: EngineContext, docId: string): SecurityStatus {
  const doc = ctx.get(docId);
  const openedWith = doc.openingPasswordRole ?? null;
  return {
    encrypted: doc.encryptedOriginal,
    method: doc.originalEncryptionMethod,
    permissions: pToPermissions(doc.originalPermissions),
    openedWith,
    canChangeProtection:
      !doc.encryptedOriginal || openedWith === 'owner' || doc.knownOwnerPassword !== undefined,
  };
}

export const namespace = 'security';
export const ops = {
  'security.status': (ctx: EngineContext, args: { docId: string }) => status(ctx, args.docId),
  'security.checkOwnerPassword': (
    ctx: EngineContext,
    args: { docId: string; password: string },
  ) => {
    const doc = ctx.get(args.docId);
    if (!doc.encryptedOriginal) return true;
    if (!doc.protectionMatchesLive)
      return doc.knownOwnerPassword !== undefined && args.password === doc.knownOwnerPassword;
    try {
      const ok = (doc.pdf.authenticatePassword(args.password) & 4) !== 0;
      if (ok) doc.knownOwnerPassword = args.password;
      return ok;
    } finally {
      if (doc.openingPassword !== undefined) doc.pdf.authenticatePassword(doc.openingPassword);
    }
  },
  'security.sanitizeScan': (
    ctx: EngineContext,
    args: { docId: string; options: SanitizeOptions },
  ) => sanitizeDocument(ctx.get(args.docId).pdf, args.options, true),
  'security.sanitize': (ctx: EngineContext, args: { docId: string; options: SanitizeOptions }) => {
    const pdf = ctx.get(args.docId).pdf;
    const counts = sanitizeDocument(pdf, args.options, true);
    if (!Object.values(counts).some(Boolean)) return { changed: false, counts };
    let applied = counts;
    const result = ctx.mutate(args.docId, 'Sanitize document', 'all', (live) => {
      applied = sanitizeDocument(live, args.options, false);
    });
    return { ...result, changed: true, counts: applied };
  },
};
