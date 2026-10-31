import { automationInputSchema, type AutomationMutation } from '../../shared/automations';
import { automationToolSchema } from '../../shared/automationTool';
import type { AutomationService } from './AutomationService';
import type { PermissionMode } from '../../shared/agentProtocol';

export interface AutomationToolOwner {
  partnerId: string; conversationId?: string; automatic: boolean; readOnly?: boolean;
  permissionMode?: PermissionMode;
  revalidate?(): Promise<void>; report?(changed: boolean): void;
  ownerKey?: string; signal?: AbortSignal;
}
/** The host supplies the invoking conversation's permission; tool arguments cannot grant full access. */
export class AutomationAgentTools {
  constructor(private readonly service: AutomationService, private readonly confirm: (request: AutomationMutation, owner: AutomationToolOwner) => Promise<boolean>) {}
  async call(raw: unknown, owner: AutomationToolOwner): Promise<string> {
    const input = automationToolSchema.parse(raw);
    await owner.revalidate?.();
    const view = await this.service.get(owner.partnerId);
    if (input.action === 'list') return JSON.stringify({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      automations: view.automations.filter(d => !d.deletedAt), runs: view.runs.slice(-20).map(run => ({ id: run.id, automationId: run.automationId, state: run.state, scheduledAt: run.scheduledAt, summary: run.summary, reason: run.reason })),
      targets: view.targets.map(({ target, label, available, reason }) => ({ conversationId: target.conversationId, label, available, reason })),
    });
    if (input.action === 'report') {
      if (!owner.automatic || !owner.report || typeof input.changed !== 'boolean') throw new Error('AUTOMATION_REPORT_REQUIRES_ACTIVE_RUN');
      owner.report(input.changed); return JSON.stringify({ reported: true });
    }
    if (owner.automatic) throw new Error('AUTOMATION_RECURSIVE_MUTATION_FORBIDDEN');
    if (owner.readOnly || owner.permissionMode === 'read_only') throw new Error('AUTOMATION_READ_ONLY');
    let request: AutomationMutation;
    if (input.action === 'create') {
      const conversationId = input.conversationId ?? owner.conversationId;
      const target = view.targets.find(t => t.target.conversationId === conversationId)?.target;
      if (!target || !input.requestId) throw new Error('AUTOMATION_ESTABLISHED_TARGET_AND_REQUEST_ID_REQUIRED');
      request = { action: 'create', requestId: input.requestId, input: automationInputSchema.parse({ target, name: input.name, instructions: input.instructions, schedule: input.schedule, timezone: input.timezone, catchUp: input.catchUp, notifications: input.notifications }) };
    } else {
      const current = view.automations.find(d => d.id === input.id && !d.deletedAt);
      if (!current) throw new Error('AUTOMATION_NOT_FOUND');
      if (input.revision !== current.revision) throw new Error('AUTOMATION_REVISION_CONFLICT');
      if (input.action === 'remove') request = { action: 'remove', id: current.id, revision: current.revision };
      else request = { action: 'update', id: current.id, revision: current.revision, input: automationInputSchema.parse({
        name: input.name ?? current.name, instructions: input.instructions ?? current.instructions, target: current.target,
        schedule: input.schedule ?? current.schedule, timezone: input.timezone ?? current.timezone,
        catchUp: input.catchUp ?? current.catchUp, notifications: input.notifications ?? current.notifications,
        enabled: input.action === 'pause' ? false : input.action === 'resume' ? true : current.enabled,
      }) };
    }
    owner.signal?.throwIfAborted();
    if (owner.permissionMode !== 'full' && !await this.confirm(request, owner)) throw new Error('AUTOMATION_USER_DECLINED');
    owner.signal?.throwIfAborted();
    await owner.revalidate?.(); // Revocation while the user was reviewing must win.
    const updated = await this.service.mutate(request, owner.partnerId);
    return JSON.stringify({ saved: true, automations: updated.automations.filter(d => !d.deletedAt) });
  }
}
