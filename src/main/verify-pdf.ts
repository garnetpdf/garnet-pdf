/** Reopen with two independent parsers before the original file is replaced. */
export async function verifyPdf(
  bytes: Uint8Array,
  expectedPageCount: number,
  password?: string,
): Promise<void> {
  const mupdf = await import('mupdf');
  const document = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
  if (!document) throw new Error('Saved file is not a PDF.');
  try {
    if (document.needsPassword() && (!password || !document.authenticatePassword(password)))
      throw new Error('Saved file could not be unlocked for verification.');
    if (document.wasRepaired()) throw new Error('Saved PDF required repair.');
    if (document.countPages() !== expectedPageCount)
      throw new Error('Saved PDF has a different page count.');
    for (let i = 0; i < expectedPageCount; i++) {
      const page = document.loadPage(i);
      try {
        const pix = page.toPixmap(
          mupdf.Matrix.scale(0.1, 0.1),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        );
        try {
          if (pix.getWidth() < 1 || pix.getHeight() < 1)
            throw new Error(`Page ${i + 1} did not render.`);
        } finally {
          pix.destroy();
        }
      } finally {
        page.destroy();
      }
    }
  } finally {
    document.destroy();
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    useSystemFonts: false,
    disableFontFace: true,
  });
  const parsed = await loading.promise;
  try {
    if (parsed.numPages !== expectedPageCount)
      throw new Error('Second PDF parser found a different page count.');
  } finally {
    await loading.destroy();
  }
}
