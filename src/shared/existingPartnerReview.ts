import { z } from 'zod';
import { delegationAccessSchema } from './delegationAccess';

export const EXISTING_PARTNER_REVIEW_PATH = '/api/asterium/reviews';
export const REVIEW_MARKDOWN_MAX_BYTES = 160_000;
export const REVIEW_RESULT_MAX_CHARACTERS = 20_000;
export const reviewFileNameSchema = z.string().max(180).regex(/^[^\\/:*?"<>|\p{Cc}]+\.md$/iu);
const threadId = z.string().min(1).max(200);

export const reviewCapabilitySchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), threadId }).strict(),
  z.object({ version: z.literal(2), threadId, permissions: z.array(delegationAccessSchema).min(1).max(2) }).strict(),
]);
const requestFields = {
  requestId: z.uuid(),
  threadId,
  message: z.string().min(1).max(4_000),
  file: z.object({
    name: reviewFileNameSchema,
    sizeBytes: z.number().int().min(1).max(REVIEW_MARKDOWN_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
};
export const reviewRequestSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...requestFields }).strict(),
  z.object({ version: z.literal(2), ...requestFields, permission: delegationAccessSchema }).strict(),
]);

const receiptFields = {
  requestId: z.uuid(),
  threadId,
  result: z.string().min(1).max(REVIEW_RESULT_MAX_CHARACTERS).optional(),
};
const statuses = ['accepted', 'running', 'succeeded', 'failed', 'busy', 'thread_changed', 'file_unreadable'] as const;
export const reviewReceiptSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...receiptFields, status: z.enum(statuses) }).strict(),
  z.object({ version: z.literal(2), ...receiptFields, permission: delegationAccessSchema,
    status: z.enum([...statuses, 'permission_denied', 'approval_required']) }).strict(),
]).refine(receipt => receipt.status === 'succeeded' ? Boolean(receipt.result?.trim()) : receipt.result === undefined);

export type ExistingPartnerReviewRequest = z.infer<typeof reviewRequestSchema>;
export type ExistingPartnerReviewCapability = z.infer<typeof reviewCapabilitySchema>;
