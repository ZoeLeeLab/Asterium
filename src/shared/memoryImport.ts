import { z } from 'zod';
import { MEMORY_TYPES } from './memoryArchive';

export const memoryImportContentKey = (record: { type: string; body: string }) =>
  JSON.stringify([record.type, record.body.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()]);

export const MEMORY_IMPORT_MAX_CHARS = 100_000;
export const importFields = z.object({ type: z.enum(MEMORY_TYPES), body: z.string().trim().min(1).max(2000) });
export const importBatchRequest = z.object({ partnerId: z.string().min(1).max(200), batchId: z.uuid() });
export const importPreviewRequest = importBatchRequest.extend({
  text: z.string().trim().min(1).max(MEMORY_IMPORT_MAX_CHARS),
  label: z.string().trim().min(1).max(255),
  endpoint: z.string().min(1).max(2048),
  model: z.string().min(1).max(500),
  provider: z.string().min(1).max(100),
}).strict();
export const importConfirmRequest = importBatchRequest.extend({
  selected: z.array(importFields.extend({ id: z.uuid() }).strict()).min(1).max(200),
}).strict();
export type MemoryImportCandidate = z.infer<typeof importFields> & { id: string; paragraph: number; excerpt: string; possibleConflicts: string[] };
export interface MemoryImportPreview {
  candidates: MemoryImportCandidate[];
  duplicateCount: number;
  rejectedCount: number;
  failedBatchCount: number;
  diagnostic?: string;
}

export interface MemoryImportReceipt { added: number; skipped: number }
export interface MemoryImportUndo { removed: number; retained: number }

export interface MemoryImportApi {
  preview(input: z.input<typeof importPreviewRequest>): Promise<MemoryImportPreview>;
  confirm(input: z.input<typeof importConfirmRequest>): Promise<MemoryImportReceipt>;
  cancel(input: z.input<typeof importBatchRequest>): Promise<void>;
  undo(input: z.input<typeof importBatchRequest>): Promise<MemoryImportUndo>;
}
