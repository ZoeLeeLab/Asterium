import { z } from 'zod';

export const EXISTING_PARTNER_REVIEW_PATH = '/api/asterium/reviews';
export const REVIEW_MARKDOWN_MAX_BYTES = 160_000;
export const REVIEW_RESULT_MAX_CHARACTERS = 20_000;
export const reviewFileNameSchema = z.string().max(180).regex(/^[^\\/:*?"<>|\p{Cc}]+\.md$/iu);
const threadId = z.string().min(1).max(200);

export const reviewCapabilitySchema = z.object({ version: z.literal(1), threadId }).strict();
export const reviewRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  threadId,
  message: z.string().min(1).max(4_000),
  file: z.object({
    name: reviewFileNameSchema,
    sizeBytes: z.number().int().min(1).max(REVIEW_MARKDOWN_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();

export const reviewReceiptSchema = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  threadId,
  status: z.enum(['accepted', 'running', 'succeeded', 'failed', 'busy', 'thread_changed', 'file_unreadable']),
  result: z.string().min(1).max(REVIEW_RESULT_MAX_CHARACTERS).optional(),
}).strict().refine(receipt => receipt.status === 'succeeded' ? Boolean(receipt.result?.trim()) : receipt.result === undefined);

export type ExistingPartnerReviewRequest = z.infer<typeof reviewRequestSchema>;
