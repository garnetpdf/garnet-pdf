/** Renderer-facing contract for the Protect, Reduce size, Export and Document panels file channels. */
export type P4bFileKind = 'pdf' | 'png' | 'jpeg' | 'any';
export interface P4bPickedFile {
  name: string;
  bytes: ArrayBuffer;
}
export interface P4bBridge {
  /** Asks for a folder. The folder stays in the main process; the renderer gets a token and the folder name. */
  pickFolder(): Promise<{ token: string; name: string } | null>;
  /** Writes one file into a picked folder. Names are cleaned and never overwrite: "name (2).png". */
  writeFile(request: {
    token: string;
    name: string;
    bytes: ArrayBuffer;
    kind: Exclude<P4bFileKind, 'any'>;
    expectedPageCount?: number;
  }): Promise<{ name: string }>;
  /** Shows a Save dialog and writes the bytes atomically. */
  saveAs(request: {
    suggestedName: string;
    bytes: ArrayBuffer;
    kind: P4bFileKind;
    expectedPageCount?: number;
  }): Promise<{ name: string } | null>;
  /** Shows an Open dialog and returns the chosen files' names and bytes. */
  pickFiles(request: { purpose: 'images' | 'any' }): Promise<P4bPickedFile[]>;
}

export function createP4bBridge(
  invoke: <T>(method: string, payload?: unknown) => Promise<T>,
): P4bBridge {
  return {
    pickFolder: () => invoke('p4b-pick-folder'),
    writeFile: (request) => invoke('p4b-write-file', request),
    saveAs: (request) => invoke('p4b-save-as', request),
    pickFiles: (request) => invoke('p4b-pick-files', request),
  };
}
