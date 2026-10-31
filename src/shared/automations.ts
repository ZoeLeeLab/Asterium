import type { PartnerEvent } from './agentProtocol';
import { isPartnerEvent } from './agentProtocolValidation';
import { z } from 'zod';

export const AUTOMATION_POLL_MS = 30_000;
export const AUTOMATION_ON_TIME_MS = 60_000;
export const AUTOMATION_CONCURRENCY = 2;
const id = z.string().min(1).max(256);
const iso = z.string().datetime({ offset: true });
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const automationScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: iso }).strict(),
  z.object({ type: z.literal('daily'), time }).strict(),
  z.object({ type: z.literal('weekly'), time, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(v => new Set(v).size === v.length) }).strict(),
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(1).max(525600) }).strict(),
]);
export const automationTargetSchema = z.object({
  partnerId: id, conversationId: id, sourceMode: z.enum(['api_partner', 'local_cli', 'existing_thread']),
  workspaceSignature: z.string().regex(/^[a-f0-9]{64}$/).optional(), nativeThreadId: id, bindingGeneration: z.number().int().positive(), projectId: id.optional(), roomId: id.optional(),
}).strict();
export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(120), instructions: z.string().trim().min(1).max(32000),
  target: automationTargetSchema, schedule: automationScheduleSchema,
  timezone: z.string().max(128).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Invalid timezone'),
  catchUp: z.enum(['same_day', 'skip']).default('same_day'),
  notifications: z.enum(['always', 'changes_or_failure']).default('always'), enabled: z.boolean().default(true),
}).strict();
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;
export type AutomationTarget = z.infer<typeof automationTargetSchema>;
export const automationSchema = automationInputSchema.extend({
  id, revision: z.number().int().positive(), scheduleRevision: z.number().int().positive(),
  createdAt: iso, updatedAt: iso, effectiveFrom: iso, deletedAt: iso.optional(), requestId: id, requestFingerprint: z.string(),
});
export type Automation = z.infer<typeof automationSchema>;
export const automationRunSchema = z.object({
  id, automationId: id, occurrenceId: id, trigger: z.enum(['scheduled', 'manual', 'retry']), attempt: z.number().int().positive(),
  scheduledAt: iso, createdAt: iso, updatedAt: iso, startedAt: iso.optional(), finishedAt: iso.optional(),
  state: z.enum(['queued', 'starting', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'skipped', 'uncertain']),
  definition: automationSchema, reason: z.string().optional(), runtimeRunId: id.optional(), summary: z.string().optional(),
  events: z.array(z.custom<PartnerEvent>(isPartnerEvent)).default([]),
  messageId: id.optional(), changed: z.boolean().optional(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;
export const automationSnapshotSchema = z.object({ version: z.literal(1), automations: z.array(automationSchema), runs: z.array(automationRunSchema) }).strict();
export type AutomationSnapshot = z.infer<typeof automationSnapshotSchema>;
export const AUTOMATION_ACTIVE_STATES: readonly AutomationRun['state'][] = ['queued', 'starting', 'running', 'waiting_approval', 'uncertain'];
export type AutomationRunOutcome = { state: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; reason?: string; summary?: string; messageId?: string; changed?: boolean };
export interface AutomationTargetOption { target: AutomationTarget; label: string; available: boolean; reason?: string }
export interface AutomationView extends AutomationSnapshot { targets: AutomationTargetOption[]; nextRuns: Record<string, string | undefined>; runtimeReady: boolean }
export const automationMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), input: automationInputSchema, requestId: id }).strict(),
  z.object({ action: z.literal('update'), id, revision: z.number().int().positive(), input: automationInputSchema }).strict(),
  z.object({ action: z.literal('remove'), id, revision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('run_now'), id, requestId: id }).strict(),
  z.object({ action: z.literal('cancel'), runId: id }).strict(),
  z.object({ action: z.literal('retry'), runId: id }).strict(),
  z.object({ action: z.literal('resolve'), runId: id, outcome: z.enum(['succeeded', 'cancelled']) }).strict(),
]);
export type AutomationMutation = z.infer<typeof automationMutationSchema>;
export interface AutomationConfirmation {
  id: string; action: 'create' | 'update' | 'remove'; partnerName: string; targetLabel: string;
  task: Pick<AutomationInput, 'name' | 'instructions' | 'schedule' | 'timezone' | 'catchUp' | 'notifications' | 'enabled'>;
}
export const automationConfirmationReplySchema = z.object({ id: z.string().uuid(), approved: z.boolean() }).strict();
export interface AsteriumAutomationsApi {
  confirmations(): Promise<AutomationConfirmation[]>;
  resolveConfirmation(reply: z.infer<typeof automationConfirmationReplySchema>): Promise<void>;
  onConfirmationsChanged(listener: () => void): () => void;
  get(): Promise<AutomationView>;
  mutate(request: AutomationMutation): Promise<AutomationView>;
  onChanged(listener: () => void): () => void;
  onEvent(listener: (payload: { run: AutomationRun; event: PartnerEvent }) => void): () => void;
}

export function automationTargetKey(t: AutomationTarget) { return JSON.stringify([t.partnerId, t.conversationId, t.sourceMode, t.nativeThreadId, t.bindingGeneration, t.projectId ?? null, t.roomId ?? null, t.workspaceSignature ?? null]); }
