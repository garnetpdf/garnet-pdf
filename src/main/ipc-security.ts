import type { z } from 'zod';

export function assertIpcSender(
  senderId: number,
  allowedId: number | undefined,
  frameUrl: string | undefined,
  isMainFrame: boolean,
): void {
  if (!allowedId || senderId !== allowedId || !frameUrl || !isMainFrame)
    throw new Error('Access denied.');
  if (frameUrl.startsWith('app://renderer/')) return;
  throw new Error('Access denied.');
}

export function parseIpcPayload<T extends z.ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
  return schema.parse(payload);
}
