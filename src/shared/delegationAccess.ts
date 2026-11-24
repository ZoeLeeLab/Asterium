import { z } from 'zod';

export const delegationAccessSchema = z.enum(['read', 'write']);

export type DelegationAccess = z.infer<typeof delegationAccessSchema>;
