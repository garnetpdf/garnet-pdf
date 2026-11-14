import * as mupdf from 'mupdf';
import { guardResources, prewarmFonts } from './resource-guard';
import type { JournalState, OpResult, PageId, PageInfo } from '../shared/engine-api';

export interface OpenDocument {
  pdf: mupdf.PDFDocument;
  revision: number;
  stateIds: number[];
  savedStateId: number;
  stateIdByRevision: Map<number, number>;
  objectToPageId: Map<number, PageId>;
  pageIdToIndex: Map<PageId, number>;
  nextPageId: number;
  transaction?: {
    label: string;
    changedPages: Set<PageId> | 'all';
    beforePosition: number;
    beforeJournal: JournalState;
  };
  droppedHistory: boolean;
  encryptedOriginal: boolean;
  originalEncryptionMethod: 'aes-256' | 'aes-128' | 'rc4-128' | 'rc4-40' | null;
  originalPermissions: number | null;
  openingPassword?: string;
  openingPasswordRole?: 'user' | 'owner';
  knownUserPassword?: string;
  knownOwnerPassword?: string;
  protectionMatchesLive: boolean;
  /** Object count when the journal started: references at or above it were made in this session. */
  baseObjects: number;
}

let nextStateId = 1;
export class EngineContext {
  readonly documents = new Map<string, OpenDocument>();
  private nextDocId = 1;

  add(
    pdf: mupdf.PDFDocument,
    preferredId?: string,
    unsaved = false,
    openingPassword?: string,
    openingPasswordRole?: 'user' | 'owner',
  ): string {
    pdf.disableJS();
    prewarmFonts(pdf);
    pdf.enableJournal();
    const docId = preferredId || `doc-${this.nextDocId++}`;
    if (this.documents.has(docId)) throw new Error('Document ID already exists.');
    const stateId = nextStateId++;
    const encryption = pdf.getMetaData('encryption');
    const encryptedOriginal = Boolean(encryption && encryption !== 'None');
    const encryptDict = encryptedOriginal ? pdf.getTrailer().get('Encrypt') : null;
    const v = encryptDict?.get('V').asNumber() ?? 0;
    const length = encryptDict?.get('Length').asNumber() ?? 0;
    const cfm = v === 4 ? encryptDict?.get('CF').get('StdCF').get('CFM').asName() : '';
    const originalEncryptionMethod = !encryptedOriginal
      ? null
      : v === 5
        ? 'aes-256'
        : v === 4 && cfm === 'AESV2'
          ? 'aes-128'
          : v === 4 || (v === 2 && length > 40)
            ? 'rc4-128'
            : v === 1 || v === 2
              ? 'rc4-40'
              : null;
    const originalPermissions = encryptDict ? encryptDict.get('P').asNumber() : null;
    this.documents.set(docId, {
      pdf,
      revision: 0,
      stateIds: [stateId],
      savedStateId: unsaved ? -1 : stateId,
      stateIdByRevision: new Map([[0, stateId]]),
      objectToPageId: new Map(),
      pageIdToIndex: new Map(),
      nextPageId: 1,
      droppedHistory: false,
      encryptedOriginal,
      originalEncryptionMethod,
      originalPermissions,
      openingPassword,
      openingPasswordRole,
      knownUserPassword: openingPasswordRole === 'user' ? openingPassword : undefined,
      knownOwnerPassword: openingPasswordRole === 'owner' ? openingPassword : undefined,
      protectionMatchesLive: true,
      baseObjects: pdf.countObjects(),
    });
    return docId;
  }

  get(docId: string): OpenDocument {
    const document = this.documents.get(docId);
    if (!document) throw new Error('Document is closed or unavailable.');
    return document;
  }

  pageIndex(docId: string, pageId: PageId): number {
    const doc = this.get(docId);
    const cached = doc.pageIdToIndex.get(pageId);
    if (cached !== undefined) return cached;
    const { pdf } = doc;
    for (let i = 0; i < pdf.countPages(); i++) {
      if (this.pageInfo(docId, i).id === pageId) return i;
    }
    throw new Error(`Page ${pageId} is no longer in this document.`);
  }

  pageInfo(docId: string, index: number): PageInfo {
    const { pdf } = this.get(docId);
    if (!Number.isInteger(index) || index < 0 || index >= pdf.countPages())
      throw new Error('Page number is out of range.');
    const page = pdf.loadPage(index);
    const bounds = page.getBounds();
    const rotationObject = page.getObject().getInheritable('Rotate');
    const pageObject = pdf.findPage(index);
    const objectNumber = pageObject.asIndirect();
    pageObject.destroy();
    const doc = this.get(docId);
    let id = doc.objectToPageId.get(objectNumber);
    if (!id) {
      id = doc.nextPageId++;
      doc.objectToPageId.set(objectNumber, id);
    }
    doc.pageIdToIndex.set(id, index);
    const info = {
      id,
      index,
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      rotation: rotationObject.isNull() ? 0 : Number(rotationObject.valueOf()) || 0,
      label: page.getLabel() || String(index + 1),
    };
    page.destroy();
    return info;
  }

  pages(docId: string): PageInfo[] {
    const doc = this.get(docId);
    const count = doc.pdf.countPages();
    doc.pageIdToIndex.clear();
    return Array.from({ length: count }, (_, i) => this.pageInfo(docId, i));
  }

  journal(docId: string): JournalState {
    return this.get(docId).pdf.getJournal();
  }

  dirty(docId: string): boolean {
    const doc = this.get(docId);
    const { position } = doc.pdf.getJournal();
    return doc.stateIds[position] !== doc.savedStateId;
  }

  result(docId: string, changedPages: PageId[] | 'all'): OpResult {
    const doc = this.get(docId);
    const result = {
      journal: doc.pdf.getJournal(),
      changedPages,
      pageCount: doc.pdf.countPages(),
      dirty: this.dirty(docId),
      revision: doc.revision,
      pages: this.pages(docId),
      historyDropped: doc.droppedHistory,
      encrypted: doc.encryptedOriginal,
      encryptionMethod: doc.originalEncryptionMethod,
      permissionsBits: doc.originalPermissions,
    };
    doc.droppedHistory = false;
    return result;
  }

  mutate(
    docId: string,
    label: string,
    changedPages: PageId[] | 'all',
    fn: (pdf: mupdf.PDFDocument) => void,
  ): OpResult {
    const doc = this.get(docId);
    if (doc.transaction) {
      fn(doc.pdf);
      if (changedPages === 'all') doc.transaction.changedPages = 'all';
      else if (doc.transaction.changedPages !== 'all')
        changedPages.forEach((id) => (doc.transaction!.changedPages as Set<PageId>).add(id));
      return {
        journal: doc.transaction.beforeJournal,
        changedPages,
        pageCount: doc.pdf.countPages(),
        dirty: true,
        revision: doc.revision,
        pages: this.pages(docId),
      };
    }
    const before = doc.pdf.getJournal();
    doc.pdf.beginOperation(label);
    try {
      fn(doc.pdf);
      this.guard(docId, changedPages);
      doc.pdf.endOperation();
    } catch (error) {
      doc.pdf.abandonOperation();
      throw error;
    }
    this.recordMutation(docId, before.position);
    return this.result(docId, changedPages);
  }

  private recordMutation(docId: string, beforePosition: number) {
    const doc = this.get(docId);
    const after = doc.pdf.getJournal();
    if (after.position !== beforePosition || after.steps.length !== doc.stateIds.length - 1) {
      doc.stateIds.length = beforePosition + 1;
      doc.stateIds.push(nextStateId++);
      doc.revision++;
      doc.stateIdByRevision.set(doc.revision, doc.stateIds[doc.pdf.getJournal().position]);
    }
    const module = globalThis.$libmupdf_wasm_Module as { HEAPU8?: Uint8Array } | undefined;
    const heapBytes = module?.HEAPU8?.byteLength ?? 0;
    if (doc.pdf.getJournal().steps.length > 500 || heapBytes > 1.2 * 1024 ** 3)
      this.checkpoint(docId);
  }

  beginTransaction(docId: string, label: string) {
    const doc = this.get(docId);
    if (doc.transaction) throw new Error('A document transaction is already open.');
    const beforeJournal = doc.pdf.getJournal();
    const beforePosition = beforeJournal.position;
    doc.pdf.beginOperation(label);
    doc.transaction = { label, changedPages: new Set<PageId>(), beforePosition, beforeJournal };
  }

  endTransaction(docId: string): OpResult {
    const doc = this.get(docId);
    const transaction = doc.transaction;
    if (!transaction) throw new Error('No document transaction is open.');
    try {
      this.guard(docId, transaction.changedPages === 'all' ? 'all' : [...transaction.changedPages]);
    } catch (error) {
      this.abortTransaction(docId);
      throw error;
    }
    doc.pdf.endOperation();
    doc.transaction = undefined;
    this.recordMutation(docId, transaction.beforePosition);
    return this.result(
      docId,
      transaction.changedPages === 'all' ? 'all' : [...transaction.changedPages],
    );
  }

  abortTransaction(docId: string): OpResult {
    const doc = this.get(docId);
    if (!doc.transaction) throw new Error('No document transaction is open.');
    doc.pdf.abandonOperation();
    doc.transaction = undefined;
    doc.revision++;
    doc.stateIdByRevision.set(doc.revision, doc.stateIds[doc.pdf.getJournal().position]);
    return this.result(docId, 'all');
  }

  private checkpoint(docId: string) {
    const doc = this.get(docId);
    const wasClean = !this.dirty(docId);
    const pageIds = this.pages(docId).map((page) => page.id);
    const copy = deepCopy(doc.pdf);
    let bytes: Uint8Array;
    try {
      const buffer = copy.saveToBuffer('garbage=compact,compress,objstms');
      bytes = Uint8Array.from(buffer.asUint8Array());
      buffer.destroy();
    } finally {
      copy.destroy();
    }
    const replacement = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
    if (!replacement || replacement.countPages() !== pageIds.length || replacement.wasRepaired())
      throw new Error('History checkpoint failed verification.');
    replacement.disableJS();
    prewarmFonts(replacement);
    replacement.enableJournal();
    doc.pdf.destroy();
    doc.pdf = replacement;
    doc.baseObjects = replacement.countObjects();
    doc.protectionMatchesLive = false;
    doc.objectToPageId.clear();
    doc.pageIdToIndex.clear();
    for (let i = 0; i < pageIds.length; i++) {
      const pageObject = replacement.findPage(i);
      doc.objectToPageId.set(pageObject.asIndirect(), pageIds[i]);
      doc.pageIdToIndex.set(pageIds[i], i);
      pageObject.destroy();
    }
    doc.stateIds = [nextStateId++];
    doc.stateIdByRevision.clear();
    doc.stateIdByRevision.set(doc.revision, doc.stateIds[0]);
    if (wasClean) doc.savedStateId = doc.stateIds[0];
    doc.droppedHistory = true;
  }

  /** Runs inside the open operation: repairs or refuses fonts and pictures broken by MuPDF's reuse tables. */
  private guard(docId: string, changedPages: PageId[] | 'all') {
    const doc = this.get(docId);
    const indexes: number[] | 'all' = changedPages === 'all' ? 'all' : [];
    if (indexes !== 'all')
      for (const id of changedPages as PageId[]) {
        try {
          indexes.push(this.pageIndex(docId, id));
        } catch {
          // Pages removed by this operation have nothing left to check.
        }
      }
    guardResources(doc.pdf, doc.baseObjects, indexes);
  }

  clearHistory(docId: string): OpResult {
    if (this.get(docId).transaction)
      throw new Error('Finish the current edit before clearing history.');
    this.checkpoint(docId);
    return this.result(docId, 'all');
  }

  travelled(docId: string): OpResult {
    const doc = this.get(docId);
    doc.revision++;
    doc.stateIdByRevision.set(doc.revision, doc.stateIds[doc.pdf.getJournal().position]);
    return this.result(docId, 'all');
  }

  markSaved(
    docId: string,
    revision?: number,
    encryption?:
      | { mode: 'remove' }
      | { mode: 'keep'; userPassword?: string; ownerPassword?: string }
      | { mode: 'set'; userPassword: string; ownerPassword: string; permissions?: number },
  ): OpResult {
    const doc = this.get(docId);
    const savedState = doc.stateIdByRevision.get(revision ?? doc.revision);
    if (!savedState) throw new Error('The document changed before the save completed. Save again.');
    doc.savedStateId = savedState;
    if (encryption?.mode === 'remove') {
      doc.encryptedOriginal = false;
      doc.originalEncryptionMethod = null;
      doc.originalPermissions = null;
      doc.knownUserPassword = undefined;
      doc.knownOwnerPassword = undefined;
      doc.protectionMatchesLive = false;
    } else if (encryption?.mode === 'set') {
      doc.encryptedOriginal = true;
      doc.originalEncryptionMethod = 'aes-256';
      doc.originalPermissions = encryption.permissions ?? doc.originalPermissions ?? -4;
      doc.knownUserPassword = encryption.userPassword;
      doc.knownOwnerPassword = encryption.ownerPassword;
      doc.protectionMatchesLive = false;
    } else if (encryption?.mode === 'keep') {
      doc.knownUserPassword = encryption.userPassword ?? doc.knownUserPassword;
      doc.knownOwnerPassword = encryption.ownerPassword ?? doc.knownOwnerPassword;
    }
    return this.result(docId, []);
  }
}

export function deepCopy(src: mupdf.PDFDocument): mupdf.PDFDocument {
  const dst = new mupdf.PDFDocument();
  const map = dst.newGraftMap();
  dst.getTrailer().put('Root', map.graftObject(src.getTrailer().get('Root')));
  const info = src.getTrailer().get('Info');
  if (!info.isNull()) dst.getTrailer().put('Info', map.graftObject(info));
  map.destroy();
  return dst;
}
