import { z } from 'zod';

export const studioWakeHintSchema = z.object({ latestEventId: z.number().int().nonnegative(), roomId: z.string().min(1).max(200),
  membershipGeneration: z.number().int().positive(), cursor: z.number().int().nonnegative(),
  wakeReason: z.enum(['user_message', 'mention', 'room_changed', 'processed']), wakeEligible: z.boolean() }).strict();
export const studioWakeTargetSchema = z.object({ partnerId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200),
  nativeThreadId: z.string().min(1).max(200), threadBindingGeneration: z.number().int().positive() }).strict();
export const studioWakeEnvelopeSchema = z.object({ protocolVersion: z.literal(2), type: z.literal('asterium.group_wake'), source: z.literal('asterium'),
  adapterId: z.string().min(1).max(200), triggerId: z.string().uuid(), roomId: z.string().min(1).max(200),
  cursor: z.number().int().nonnegative(), membershipGeneration: z.number().int().positive(), latestEventId: z.number().int().nonnegative(),
  wakeReason: z.enum(['user_message', 'mention']), target: studioWakeTargetSchema,
  outputRoute: z.object({ type: z.literal('asterium.group'), roomId: z.string().min(1).max(200), membershipGeneration: z.number().int().positive() }).strict(),
}).strict().refine((value) => value.roomId === value.outputRoute.roomId && value.membershipGeneration === value.outputRoute.membershipGeneration);
export const studioWakeConnectionStatusSchema = z.object({ phase: z.enum(['stopped', 'connecting', 'connected']),
  reason: z.enum(['eof', 'network_error', 'protocol_error', 'connect_timeout', 'unauthorized', 'manual']).optional() }).strict();
export const studioWakeControlRequestSchema = z.object({ protocolVersion: z.literal(2), source: z.literal('asterium'),
  action: z.enum(['connect_once', 'status', 'retry', 'ignore', 'resume']), requestId: z.string().uuid(),
  connectionBindingId: z.string().min(1).max(200), triggerId: z.string().uuid().optional() }).strict()
  .refine((value) => ['retry', 'ignore'].includes(value.action) === Boolean(value.triggerId));
export const studioWakeReviewSchema = z.object({ roomId: z.string().min(1), membershipGeneration: z.number().int().positive(),
  eventId: z.number().int().nonnegative(), triggerId: z.string().uuid(), reason: z.enum(['uncertain', 'replay', 'rejected']) }).strict();
export const studioWakeControlReplySchema = z.object({ protocolVersion: z.literal(2), requestId: z.string().uuid(),
  connectionBindingId: z.string().min(1), connection: studioWakeConnectionStatusSchema,
  duplicate: z.boolean(), paused: z.enum(['quota', 'pending_limit']).optional(), reviews: z.array(studioWakeReviewSchema).max(64) }).strict();
export type StudioWakeTarget = z.infer<typeof studioWakeTargetSchema>;
export type StudioWakeEnvelope = z.infer<typeof studioWakeEnvelopeSchema>;
export type StudioWakeControlRequest = z.infer<typeof studioWakeControlRequestSchema>;
export type StudioWakeControlReply = z.infer<typeof studioWakeControlReplySchema>;
export type StudioWakeReview = z.infer<typeof studioWakeReviewSchema>;
