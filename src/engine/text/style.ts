import type { TextRun } from '@garnet/pdf-content';

export const simulatedItalicShear = Math.tan(Math.PI / 15);
/** Recognise the app's explicit shear independently of MuPDF's font deduplication. */
export function hasSimulatedItalic(run: TextRun): boolean {
  return (
    !!run.markedContent?.some((tag) => tag.startsWith('GarnetTextBox_')) &&
    Math.abs(run.textMatrix[1]) < 1e-6 &&
    Math.abs(run.textMatrix[2] / run.textMatrix[3] - simulatedItalicShear) < 1e-4
  );
}
