import { z } from 'zod';
import { automationTargetSchema } from './automations';

export const AUTOMATION_ADAPTER_PROTOCOL = 1;
export const automationAdapterBindingSchema = automationTargetSchema.extend({
  sourceMode: z.literal('existing_thread'), adapterId: z.string().min(1).max(200),
  workspaceSignature: z.string().regex(/^[a-f0-9]{64}$/), membershipGeneration: z.number().int().positive().optional(),
}).strict().refine(t => !t.roomId || (Boolean(t.projectId) && t.membershipGeneration !== undefined), 'Group membership generation is required');
export const automationAdapterTriggerSchema = z.object({
  protocolVersion: z.literal(AUTOMATION_ADAPTER_PROTOCOL), source: z.literal('asterium'), type: z.literal('asterium.automation'),
  triggerId: z.string().min(1).max(200), occurrenceId: z.string().min(1).max(300), automationId: z.string().min(1).max(200),
  scheduledAt: z.iso.datetime(), name: z.string().min(1).max(120), instructions: z.string().min(1).max(32000),
  binding: automationAdapterBindingSchema,
  delivery: z.literal('original_conversation_only'), allowNewThread: z.literal(false), echoToWeChat: z.literal(false),
}).strict();
export type AutomationAdapterBinding = z.infer<typeof automationAdapterBindingSchema>;
export type AutomationAdapterTrigger = z.infer<typeof automationAdapterTriggerSchema>;
export const automationAdapterReceiptSchema = z.object({
  protocolVersion: z.literal(AUTOMATION_ADAPTER_PROTOCOL), triggerId: z.string().min(1).max(200),
  state: z.enum(['accepted', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'uncertain']),
  runtimeRunId: z.string().min(1).max(200).optional(), summary: z.string().max(32000).optional(), changed: z.boolean().optional(),
}).strict();
export type AutomationAdapterReceipt = z.infer<typeof automationAdapterReceiptSchema>;
export const automationAdapterCapabilitiesSchema = z.object({
  protocolVersion: z.literal(AUTOMATION_ADAPTER_PROTOCOL), automation: z.literal(true), originalThread: z.literal(true),
  serialized: z.literal(true), permissionsPreserved: z.literal(true), noPublicEcho: z.literal(true), durableIdempotency: z.literal(true),
}).strict();
export interface AutomationAdapterPort {
  capabilities(): Promise<z.infer<typeof automationAdapterCapabilitiesSchema>>;
  dispatch(trigger: AutomationAdapterTrigger, signal: AbortSignal): Promise<AutomationAdapterReceipt>;
  status(triggerId: string, signal: AbortSignal): Promise<AutomationAdapterReceipt | undefined>;
  cancel(triggerId: string, signal: AbortSignal): Promise<AutomationAdapterReceipt>;
}
