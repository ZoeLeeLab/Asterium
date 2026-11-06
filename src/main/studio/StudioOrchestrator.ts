import type { ResolvedContextHandoff } from '../../shared/contextHandoff';
import type { AsteriumRuntimeContextInput } from '../../shared/agentProtocol';
import { DEFAULT_STUDIO_SPEAKING_MODE, STUDIO_PASS_MARKER, type StudioPreparedTurn, type StudioRoomSnapshot, type StudioStartRoundRequest } from '../../shared/studioRuntime';
import type { StudioRuntimeLifecyclePort } from '../runtime/PartnerRuntimePort';
import type { StudioRoomStore } from './StudioRoomStore';
import type { StudioPartnerRecord, StudioRuntimeCatalog } from './StudioRuntimeCatalog';
import { studioPassPolicy } from './StudioPassPolicy';
import type { ProjectExecutionPolicyStore } from '../project/ProjectExecutionPolicyStore';
import type { StudioAttachments } from './StudioAttachments';

interface StudioProjectMutationPort {
  run<T>(operation: () => Promise<T>): Promise<T>;
  assertProjectActive(projectId: string): void;
}

export class StudioOrchestrator {
  private readonly handoffs = new Map<string, { messageId: string; draft: ResolvedContextHandoff }>();
  private readonly startingTurns = new Set<string>();
  private readonly cancelledRounds = new Set<string>();
  private readonly passCorrections = new Set<string>();

  constructor(
    private readonly rooms: Pick<StudioRoomStore, 'getRoom' | 'publishUserMessage' | 'cancelRound' | 'failPreparedTurn'>,
    private readonly catalog: StudioRuntimeCatalog,
    private readonly runtime: StudioRuntimeLifecyclePort,
    private readonly projectMutations?: StudioProjectMutationPort,
    private readonly executionPolicies?: Pick<ProjectExecutionPolicyStore, 'getOrCreate'>,
    private readonly attachments?: Pick<StudioAttachments, 'prepareMessage' | 'published'>,
  ) {}

  handleSnapshot(snapshot: StudioRoomSnapshot) {
    const handoff = this.handoffs.get(snapshot.metadata.roomId);
    const round = snapshot.activeRound;
    if (handoff && round?.triggerMessageId === handoff.messageId && ['completed', 'failed', 'cancelled'].includes(round.state)) {
      this.handoffs.delete(snapshot.metadata.roomId);
    }
    if (snapshot.activeRound?.state === 'queued') void this.startQueuedTurn(snapshot);
  }

  markPassCorrection(roomId: string, roundId: string, partnerId: string) {
    this.passCorrections.add(`${roomId}:${roundId}:${partnerId}`);
  }

  startRound(request: StudioStartRoundRequest, contextHandoff?: ResolvedContextHandoff) {
    return this.projectMutations
      ? this.projectMutations.run(() => {
          this.projectMutations!.assertProjectActive(request.room.projectId);
          return this.startRoundUnlocked(request, contextHandoff);
        })
      : this.startRoundUnlocked(request, contextHandoff);
  }

  private async startRoundUnlocked(request: StudioStartRoundRequest, contextHandoff?: ResolvedContextHandoff) {
    const current = await this.rooms.getRoom(request.room.roomId);
    if (current?.metadata.archived) throw new Error('STUDIO_ROOM_ARCHIVED');
    if (current?.activeRound && !['completed', 'failed', 'cancelled'].includes(current.activeRound.state)) throw new Error('STUDIO_ROUND_ALREADY_ACTIVE');
    const room = current?.metadata ?? request.room;
    const settings = current?.settings ?? { speakingMode: DEFAULT_STUDIO_SPEAKING_MODE, selectedPartnerIds: [], discussionProtectionEnabled: false };
    const mutedPartnerIds = current?.mutedPartnerIds ?? [];
    const rotationOffset = current?.rotationOffset ?? 0;
    const members = this.catalog.members(room.memberIds).filter((partner) => partner.available || partner.sourceMode === 'existing_thread');
    const availableIds = members.filter((partner) => !mutedPartnerIds.includes(partner.partnerId)).map((partner) => partner.partnerId);
    const mentionedIds = unique(request.mentions?.map((mention) => mention.partnerId) ?? []);
    if (mentionedIds.some((partnerId) => !availableIds.includes(partnerId))) throw new Error('STUDIO_MENTION_TARGET_UNAVAILABLE');
    const offset = availableIds.length ? rotationOffset % availableIds.length : 0;
    const rotated = [...availableIds.slice(offset), ...availableIds.slice(0, offset)];
    const speakerQueue = settings.speakingMode === 'selected_partners'
      ? settings.selectedPartnerIds.filter((partnerId) => availableIds.includes(partnerId))
      : settings.speakingMode === 'free_discussion' && mentionedIds.length
        ? mentionedIds
        : rotated;
    if (!speakerQueue.length) throw new Error('STUDIO_ROUND_HAS_NO_SPEAKERS');
    const externalParticipantIds = speakerQueue.filter((id) => members.some((partner) => partner.partnerId === id && partner.sourceMode === 'existing_thread'));
    const managedQueue = speakerQueue.filter((id) => !externalParticipantIds.includes(id));
    if (contextHandoff && (!managedQueue.includes(contextHandoff.partnerId)
      || current?.messages.some(item => item.messageId === request.messageId))) throw new Error('HANDOFF_PARTNER_NOT_QUEUED');
    const policy = this.executionPolicies ? await this.executionPolicies.getOrCreate(room.projectId) : { permissionMode: 'manual' as const };
    const publicRequest = { ...request };
    delete publicRequest.contextHandoff;
    const message = this.attachments ? await this.attachments.prepareMessage(publicRequest) : publicRequest;
    const pending = contextHandoff ? { messageId: request.messageId, draft: contextHandoff } : undefined;
    if (pending) this.handoffs.set(room.roomId, pending);
    let published: StudioRoomSnapshot;
    try {
      published = externalParticipantIds.length
        ? await this.rooms.publishUserMessage({ ...message, room, speakerQueue: managedQueue }, policy.permissionMode, externalParticipantIds)
        : await this.rooms.publishUserMessage({ ...message, room, speakerQueue: managedQueue }, policy.permissionMode);
    } catch (error) {
      if (pending && this.handoffs.get(room.roomId) === pending) this.handoffs.delete(room.roomId);
      throw error;
    }
    await this.attachments?.published(publicRequest);
    return published;
  }

  async cancelRound(roomId: string) {
    const before = await this.rooms.getRoom(roomId);
    const round = before?.activeRound;
    if (round) this.cancelledRounds.add(`${roomId}:${round.roundId}`);
    const running = round?.members.find((member) => member.state === 'running');
    const snapshot = await this.rooms.cancelRound(roomId);
    const partner = running ? this.catalog.partner(running.partnerId) : undefined;
    if (partner && running?.runId && running.sessionId && running.conversationId && running.bindingGeneration !== undefined && running.inputThroughSeq !== undefined) await this.runtime.cancelRun({
      partner,
      conversationId: running.conversationId,
      runId: running.runId,
      sessionId: running.sessionId,
      route: { scope: 'group', roomId, roundId: round!.roundId, bindingGeneration: running.bindingGeneration, inputThroughSeq: running.inputThroughSeq },
    }, '用户停止了本轮群聊').catch(() => undefined);
    return snapshot;
  }

  private async startQueuedTurn(snapshot: StudioRoomSnapshot) {
    const round = snapshot.activeRound;
    const partnerId = round?.members.find((member) => member.state === 'queued')?.partnerId;
    if (!round || round.state !== 'queued' || !partnerId) return;
    const key = `${snapshot.metadata.roomId}:${round.roundId}:${partnerId}`;
    const roundKey = `${snapshot.metadata.roomId}:${round.roundId}`;
    if (this.startingTurns.has(key)) return;
    const partner = this.catalog.partner(partnerId);
    if (!partner?.available || partner.runtime.kind === 'unsupported') {
      this.cancelledRounds.add(roundKey);
      await this.rooms.cancelRound(snapshot.metadata.roomId).catch(() => undefined);
      return;
    }
    this.startingTurns.add(key);
    const correctingPass = this.passCorrections.delete(key);
    let prepared: StudioPreparedTurn | undefined;
    try {
      prepared = await this.runtime.prepareStudioTurn(partner, snapshot.metadata.roomId, round.roundId);
      const members = this.catalog.members(prepared.room.memberIds);
      const user = this.catalog.user();
      const content = correctingPass
        ? groupPassCorrectionPrompt(prepared, partner)
        : groupRuntimePrompt(prepared, partner, members, user);
      const context = groupRuntimeContext(prepared, partner, members, user);
      const pending = this.handoffs.get(prepared.room.roomId);
      const contextHandoff = pending?.messageId === prepared.round.triggerMessageId && pending.draft.partnerId === partnerId
        && prepared.room.memberIds.includes(partnerId) ? pending.draft : undefined;
      if (contextHandoff) this.handoffs.delete(prepared.room.roomId);
      const receipt = await this.runtime.startStudioTurn({ partner, prepared, content, context, ...(contextHandoff ? { contextHandoff } : {}) });
      if (this.cancelledRounds.has(roundKey)) await this.runtime.cancelRun({
        partner,
        conversationId: prepared.conversationId,
        runId: receipt.runId,
        sessionId: receipt.sessionId,
        route: { scope: 'group', roomId: prepared.room.roomId, roundId: prepared.round.roundId, bindingGeneration: prepared.bindingGeneration, inputThroughSeq: prepared.inputThroughSeq },
      }, '用户已停止本轮群聊').catch(() => undefined);
    } catch (error) {
      console.error('Failed to start studio partner turn.', error);
      if (prepared) await this.rooms.failPreparedTurn(prepared.room.roomId, prepared.round.roundId, partnerId).catch(() => undefined);
    } finally {
      this.startingTurns.delete(key);
    }
  }
}

function groupRuntimePrompt(
  prepared: StudioPreparedTurn,
  partner: StudioPartnerRecord,
  partners: StudioPartnerRecord[],
  userProfile: { displayName: string; introduction: string },
) {
  const firstTurnForBinding = !prepared.nativeThreadId;
  const userName = userProfile.displayName.trim() || '用户';
  const userLabel = userName === '用户' ? '用户' : `${userName}（用户）`;
  const speakingModeLabel = studioSpeakingModeLabel(prepared.settings.speakingMode);
  const mentionAvailable = prepared.settings.speakingMode === 'free_discussion';
  const speakingModeChanged = firstTurnForBinding || prepared.previousSpeakingMode !== prepared.settings.speakingMode;
  const citationReminderRequired = firstTurnForBinding || Boolean(prepared.omittedRange);
  const passAllowed = studioPassPolicy({ settings: prepared.settings, messages: prepared.messages, round: prepared.round, partnerId: partner.partnerId }).allowed;
  const history = prepared.messages.filter((message) => message.authorId !== partner.partnerId).map((message) => {
    const partnerName = partners.find((item) => item.partnerId === message.authorId)?.publicIdentity.displayName ?? '伙伴';
    const author = message.authorType === 'user'
      ? userLabel
      : message.authorType === 'system'
        ? '系统'
        : partnerName;
    const suffix = message.status === 'interrupted' ? '（这段回复曾被中断）' : '';
    const attachments = message.attachments?.map(item => `- ${item.name} (${item.mediaType}, ${item.sizeBytes} bytes), attachment_id: ${item.id}`).join('\n');
    return `[${message.seq}] ${author}${suffix}：${message.content}${attachments ? `\n[用户附件]\n${attachments}` : ''}`;
  }).join('\n\n');
  const omission = prepared.omittedRange
    ? `较早的 ${prepared.omittedRange.fromSeq}–${prepared.omittedRange.throughSeq} 条消息因上下文预算未附带。\n\n`
    : '';
  return [
    ...(citationReminderRequired ? ['引用群聊中的具体消息时，请使用“伙伴名字[消息序号]”，不要虚构不存在的序号。', ''] : []),
    ...(speakingModeChanged ? [
      `当前发言模式：${speakingModeLabel}。${mentionAvailable ? '可以使用 mention_partner 邀请其他未禁言伙伴；成功后对方会移到下一位发言。' : ''}`,
      ...(firstTurnForBinding ? ['如需核对当前模式、队列和可用能力，可查询 asterium_status(key=conversation)。'] : []),
      '',
    ] : []),
    ...(firstTurnForBinding
      ? [`${omission}你本次需要处理的公开群聊增量：`]
      : omission ? [omission.trimEnd()] : []),
    history || '（没有新的公开内容）',
    '',
    ...(prepared.round.discussionWarningIssued ? ['[讨论保护提醒] 本次伙伴讨论已持续多轮，请开始归纳并结束交流；除非仍有必须确认的问题，否则不要继续邀请其他伙伴发言。', ''] : []),
    ...(speakingModeChanged && mentionAvailable ? ['如需真正邀请另一位伙伴继续本轮讨论，必须调用 mention_partner。参数可使用唯一的伙伴名字、@名或 partnerId；名字重复时请先查 asterium_status(key=partners) 并使用 partnerId。只在正文写 @名字 不会触发发言。'] : []),
    ...(speakingModeChanged && mentionAvailable && passAllowed
      ? [`请直接给出适合公开群聊的回复。如果你明确判断本轮没有需要补充的内容，只输出 ${STUDIO_PASS_MARKER}，不要附加其他文字。`]
      : !passAllowed && (speakingModeChanged || mentionAvailable) ? ['请直接给出一条适合公开群聊的可见回复。'] : []),
  ].join('\n');
}

function groupPassCorrectionPrompt(prepared: StudioPreparedTurn, partner: StudioPartnerRecord) {
  const policy = studioPassPolicy({ settings: prepared.settings, messages: prepared.messages, round: prepared.round, partnerId: partner.partnerId });
  const reason = policy.reason === 'explicit_mention'
    ? '你被明确点名，本轮不允许跳过发言。'
    : `当前发言模式为${studioSpeakingModeLabel(prepared.settings.speakingMode)}，不允许跳过发言。`;
  return `[系统纠正] ${reason}请针对刚才的公开群聊增量给出一条可见回复。`;
}

function groupRuntimeContext(
  prepared: StudioPreparedTurn,
  partner: StudioPartnerRecord,
  partners: StudioPartnerRecord[],
  userProfile: { displayName: string; introduction: string },
): AsteriumRuntimeContextInput {
  const members = prepared.room.memberIds.map((id) => partners.find((item) => item.partnerId === id)).filter((item): item is StudioPartnerRecord => Boolean(item));
  const speakingModeLabel = studioSpeakingModeLabel(prepared.settings.speakingMode);
  const mentionPartnerAvailable = prepared.settings.speakingMode === 'free_discussion';
  const passAllowed = studioPassPolicy({ settings: prepared.settings, messages: prepared.messages, round: prepared.round, partnerId: partner.partnerId }).allowed;
  return {
    partner: {
      displayName: partner.publicIdentity.displayName,
      introduction: partner.publicIdentity.introduction,
      expertise: partner.publicIdentity.expertise,
      mentionName: partner.publicIdentity.mentionName,
      avatarAvailable: Boolean(partner.publicIdentity.avatarDataUrl),
      ...(partner.personality ? { personality: partner.personality } : {}),
    },
    runtime: { ...partner.runtimeContext },
    ...(partner.management.userProfile ? { user: { displayName: userProfile.displayName, introduction: userProfile.introduction } } : {}),
    conversation: {
      title: prepared.room.name,
      studio: {
        roomId: prepared.room.roomId,
        projectId: prepared.room.projectId,
        explicitDeliveryTarget: 'room_project',
        speakingMode: prepared.settings.speakingMode,
        speakingModeLabel,
        passAllowed,
        mentionPartnerAvailable,
        mentionPartnerReason: mentionPartnerAvailable ? '可以邀请其他未禁言伙伴。' : '发言顺序由用户设置决定，伙伴不能追加邀请。',
        discussionProtectionEnabled: prepared.settings.discussionProtectionEnabled,
        selectedPartnerIds: [...prepared.settings.selectedPartnerIds],
        mutedPartnerIds: [...prepared.mutedPartnerIds],
        speakerQueue: prepared.round.members.filter((member) => member.state === 'queued' || member.state === 'running').map((member) => member.partnerId),
      },
    },
    partners: members.map((member) => ({
      partnerId: member.partnerId,
      displayName: member.publicIdentity.displayName,
      mentionName: member.publicIdentity.mentionName || member.publicIdentity.displayName,
      expertise: member.publicIdentity.expertise,
      model: prepared.models[member.partnerId]?.model ?? member.recentModel?.model ?? member.fallbackModel,
      modelStatus: prepared.models[member.partnerId]?.status ?? member.recentModel?.status ?? 'unknown',
      groupMentionAvailable: mentionPartnerAvailable && member.partnerId !== partner.partnerId && !prepared.mutedPartnerIds.includes(member.partnerId) && (member.available || member.sourceMode === 'existing_thread'),
    })),
  };
}

function studioSpeakingModeLabel(mode: StudioPreparedTurn['settings']['speakingMode']) {
  if (mode === 'free_discussion') return '自由讨论';
  if (mode === 'selected_partners') return '指定发言';
  return '逐一回应';
}

function unique(values: string[]) {
  return [...new Set(values)];
}
