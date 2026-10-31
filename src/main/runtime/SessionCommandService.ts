import { appliedProfiles } from './AppliedSessionProfiles';
import type { PartnerEvent } from '../../shared/agentProtocol';
import { assertSessionCommandTarget, type SessionCommandTarget, type SessionCommandRequest, type SessionCommandResult, type SessionStatus } from '../../shared/sessionCommands';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import { conversationWriterScope, type WriterLeaseCoordinator } from './WriterLeaseCoordinator';
import type { SessionCompactionService } from './SessionCompactionService';

export class SessionCommandService {
  private readonly runs = new Map<string, { runId: string; state: SessionStatus['state'] }>();
  constructor(private readonly deps: {
    bindings: Pick<NativeThreadBindingStore, 'getForScope'>;
    catalog: Pick<StudioRuntimeCatalog, 'partner'>;
    messages: Pick<SingleChatMessageStore, 'getConversation'>;
    leases: WriterLeaseCoordinator;
    compactions: Pick<SessionCompactionService, 'compact'>;
    isDeleted: (id: string) => Promise<boolean>;
    reload?: (request: SessionCommandRequest) => Promise<SessionCommandResult>;
  }) {}

  observe(event: PartnerEvent) {
    if (event.route && event.route.scope !== 'single') return;
    const key = JSON.stringify([event.partnerId, event.conversationId]);
    if (event.type === 'session.bound') this.runs.set(key, { runId: event.runId, state: 'running' });
    const run = this.runs.get(key);
    if (!run || run.runId !== event.runId) return;
    if (event.type === 'work.status') run.state = event.state === 'waiting_authorization' || event.state === 'waiting_user_input' ? event.state : 'running';
    if (event.type === 'authorization.requested' && event.resolution !== 'display_only') run.state = 'waiting_authorization';
    if (event.type === 'user_input.requested') run.state = 'waiting_user_input';
    if (event.type === 'authorization.resolved' || event.type === 'user_input.resolved') run.state = 'running';
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') this.runs.delete(key);
  }

  async inspect(target: SessionCommandTarget): Promise<SessionStatus> {
    assertSessionCommandTarget(target);
    if (await this.deps.isDeleted(target.conversationId)) throw new Error('SESSION_COMMAND_UNAVAILABLE');
    const partner = this.deps.catalog.partner(target.partnerId);
    if (!partner || partner.sourceMode !== target.source) throw new Error('SESSION_COMMAND_PARTNER_MISMATCH');
    const [binding, indexed] = await Promise.all([
      this.deps.bindings.getForScope(target.partnerId, 'single', target.conversationId),
      this.deps.messages.getConversation(target.conversationId),
    ]);
    if (indexed && indexed.partnerId !== target.partnerId) throw new Error('SESSION_COMMAND_PARTNER_MISMATCH');
    const sessionId = binding?.nativeThreadId ?? indexed?.sessionId;
    if (binding && binding.source !== target.source || target.sessionId && sessionId !== target.sessionId) throw new Error('SESSION_COMMAND_THREAD_MISMATCH');
    const owner = this.deps.leases.ownerFor(conversationWriterScope(target));
    const run = this.runs.get(JSON.stringify([target.partnerId, target.conversationId]));
    const state: SessionStatus['state'] = owner?.startsWith('compact:') || owner?.startsWith('reload:') ? 'maintenance' : owner ? run?.state ?? 'running' : 'idle';
    const recent = partner.recentModel?.conversationId === target.conversationId && partner.recentModel.threadId === sessionId ? partner.recentModel : undefined;
    const reason = !partner.available || partner.runtime.kind === 'unsupported' || target.source === 'existing_thread' ? '当前伙伴不提供可控制的会话压缩'
      : partner.runtime.kind === 'api' && indexed?.apiSessionHistoryEnabled === false ? '请先开启此伙伴的会话记录'
        : !sessionId || !binding || binding.state !== 'active' ? '先完成一轮对话后再压缩'
          : indexed?.isArchived || indexed?.isDisabled ? '请先恢复或启用这段对话'
            : binding.profileRecoveryRequired ? '上次资料重读需要恢复，请重试资料重读或新建对话'
              : owner || indexed?.busy ? '请等待当前任务结束' : undefined;
    const profiles = appliedProfiles(binding?.bootstrap);
    const reloadReason = !partner.available || target.source === 'existing_thread' ? '当前伙伴不支持星丛资料重读'
      : !sessionId || binding?.state !== 'active' ? '先完成一轮对话后再重读'
        : indexed?.isArchived || indexed?.isDisabled ? '请先恢复或启用这段对话' : owner ? '请等待当前任务结束' : undefined;
    return {
      ...target, sessionId, model: recent?.model ?? (partner.runtime.kind === 'api' ? partner.runtime.connection.model : '尚未报告'),
      modelStatus: recent ? 'recent' : partner.runtime.kind === 'api' ? 'configured' : 'unknown', state,
      permissionMode: indexed?.permissionMode, planMode: indexed?.planMode, planStatus: indexed?.planStatus,
      appliedProfiles: { user: profiles.user?.version ?? '未知', persona: profiles.persona?.version ?? '未知' },
      ...(binding?.profileRecoveryRequired ? { profileRecoveryRequired: true } : {}),
      capabilities: { status: { available: true }, compact: { available: !reason, ...(reason ? { reason } : {}) }, 'reload-user': { available: !reloadReason, reason: reloadReason }, 'reload-persona': { available: !reloadReason, reason: reloadReason } }, observedAt: new Date().toISOString(),
    };
  }

  async execute(request: SessionCommandRequest): Promise<SessionCommandResult> {
    assertSessionCommandTarget(request, true);
    const { command, commandId, ...target } = request;
    const session = await this.inspect(target);
    if (command === 'status') return { status: 'success', message: '会话状态已更新', session };
    if (command === 'reload-user' || command === 'reload-persona') {
      const capability = session.capabilities[command];
      if (!capability.available || !this.deps.reload) throw new Error(capability.reason ?? 'SESSION_COMMAND_UNAVAILABLE');
      return this.deps.reload({ ...request, sessionId: session.sessionId });
    }
    if (!session.capabilities.compact.available || !session.sessionId) throw new Error(session.capabilities.compact.reason ?? 'SESSION_COMMAND_UNAVAILABLE');
    const result = await this.deps.compactions.compact({ ...target, sessionId: session.sessionId, commandId });
    return { status: result.status === 'compacted' ? 'success' : 'info', message: result.message };
  }
}
