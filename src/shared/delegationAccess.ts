import { z } from 'zod';

export const delegationAccessSchema = z.enum(['read', 'write']);
export const delegationExecutionSchema = z.object({
  access: delegationAccessSchema,
  permissionMode: z.enum(['read_only', 'manual', 'automatic', 'full']),
}).strict().refine(value => value.access === 'read'
  ? value.permissionMode === 'read_only' : value.permissionMode !== 'read_only');

export type DelegationAccess = z.infer<typeof delegationAccessSchema>;
export type DelegationExecution = z.infer<typeof delegationExecutionSchema>;
