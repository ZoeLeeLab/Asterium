import { appliedProfiles } from './AppliedSessionProfiles';
import type { SendMessageCommand } from '../../shared/agentProtocol';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import type { PartnerMemoryBriefingService } from '../memory/PartnerMemoryBriefingService';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import { DELIVERY_INSTRUCTION } from '../adapters/deliveryInstructions';
import { assembleSessionBootstrap } from './SessionBootstrapAssembler';
import { projectNotebookToolAccess, runtimeToolInstructions } from './AsteriumRuntimeTools';

export class SessionBootstrapService {
  constructor(
    private readonly profiles: Pick<PartnerProfileStore, 'runtimeProfile' | 'runtimeUserProfile' | 'managedPersonaState'>,
    private readonly briefings: Pick<PartnerMemoryBriefingService, 'get'>,
    private readonly bindings: Pick<NativeThreadBindingStore, 'getForScope'>,
    private readonly rooms: Pick<StudioRoomStore, 'getRoom'>,
    private readonly apiSessions?: Pick<import('../api/ApiAgentSessionStore').ApiAgentSessionStore, 'load'>,
  ) {}

  async prepare(command: SendMessageCommand) {
    delete command.sessionBootstrap;
    delete command.sessionBootstrapVersion;
    delete command.managedPersonaUpdate;
    if (command.runtimeContext) delete command.runtimeContext.memoryBriefing;
    if (command.connectionSource !== 'existing_thread' && command.apiContext) {
      delete command.apiContext.systemPrompt;
      delete command.apiContext.userProfileContext;
    }
    const profile = await this.profiles.runtimeProfile(command.partnerId);
    if (!profile) {
      if (command.connectionSource !== 'existing_thread') throw new Error('PARTNER_PROFILE_NOT_FOUND');
      return undefined;
    }
    const user = !command.sessionId && profile.management.userProfile ? await this.profiles.runtimeUserProfile() : undefined;
    const partner = {
      ...profile.publicIdentity,
      avatarAvailable: Boolean(profile.publicIdentity.avatarDataUrl),
      ...(!command.sessionId && profile.management.personality ? { personality: profile.personality, systemPrompt: profile.systemPrompt } : {}),
    };
    command.runtimeContext = {
      ...command.runtimeContext,
      partner,
      runtime: command.runtimeContext?.runtime ?? { source: command.connectionSource },
    };
    if (user) command.runtimeContext.user = { displayName: user.displayName, introduction: user.introduction };
    else delete command.runtimeContext.user;
    if (command.connectionSource === 'existing_thread') return profile;
    if (command.sessionId) {
      const scope = command.route?.scope ?? 'single';
      const scopeId = command.route?.scope === 'group' ? command.route.roomId
        : command.route?.scope === 'workspace' ? command.route.projectId
          : command.route?.scope === 'workflow_planning' ? command.route.generationId : command.conversationId;
      const binding = await this.bindings.getForScope(command.partnerId, scope, scopeId);
      if (binding?.nativeThreadId === command.sessionId) {
        if (binding.profileRecoveryRequired) throw new Error('PROFILE_RELOAD_RECOVERY_REQUIRED');
        command.sessionBootstrapVersion = binding.bootstrapVersion;
        command.sessionBootstrap = binding.bootstrap;
        const applied = appliedProfiles(binding.bootstrap);
        if (applied.user?.enabled) command.runtimeContext.user = { displayName: applied.user.displayName ?? '', introduction: applied.user.introduction ?? '' };
        if (applied.persona?.enabled) Object.assign(command.runtimeContext.partner, { personality: applied.persona.personality, systemPrompt: applied.persona.systemPrompt });
      }
      if (!command.sessionBootstrap && command.connectionSource === 'api_partner') {
        const stored = await this.apiSessions?.load(command.partnerId, command.conversationId);
        if (stored?.bootstrapSystemPrompt) command.sessionBootstrap = { version: 1, content: stored.bootstrapSystemPrompt, createdAt: '', timeZone: '', appliedProfiles: {} };
      }
      return profile;
    }
    const route = command.route;
    const daily = !route || route.scope === 'single' || route.scope === 'group';
    const memoryBriefing = daily && profile.management.memoryMode === 'asterium'
      ? (await this.briefings.get(command.partnerId)).content : undefined;
    const persona = profile.management.personality ? await this.profiles.managedPersonaState(command.partnerId) : undefined;
    const group = route?.scope === 'group' ? await this.rooms.getRoom(route.roomId) : undefined;
    const platformContext = group ? [
      `你正在星丛项目 ${group.metadata.projectId} 的公开群聊「${group.metadata.name}」中发言。这里不是单聊。`,
      '公开回复只披露适合当前讨论的内容；不要泄露私人记忆、私人单聊或其他伙伴未公开的信息。不要把群聊中的临时讨论写进私人记忆。',
      '当前群聊初始成员（名字｜@名称｜partnerId）：',
      ...(await Promise.all(group.metadata.memberIds.map(async (id) => {
        const member = await this.profiles.runtimeProfile(id);
        return member ? `- ${member.publicIdentity.displayName}｜@${member.publicIdentity.mentionName}｜${id}` : `- ${id}`;
      }))),
    ].join('\n') : undefined;
    const workflow = route?.scope === 'workflow_planning';
    command.sessionBootstrap = assembleSessionBootstrap({
      source: command.connectionSource, route, partnerName: profile.publicIdentity.displayName,
      management: profile.management, user,
      ...(persona?.enabled ? { persona: { personality: persona.personality, systemPrompt: persona.systemPrompt, version: persona.version } } : {}),
      memoryBriefing, platformContext,
      behaviorRules: [
        runtimeToolInstructions(route?.scope === 'group' && Boolean(command.runtimeContext.conversation?.studio?.mentionPartnerAvailable), route?.scope === 'workspace', workflow, 'none', projectNotebookToolAccess(route)),
        workflow ? '' : DELIVERY_INSTRUCTION,
      ].filter(Boolean).join('\n\n'),
    });
    command.sessionBootstrapVersion = command.sessionBootstrap?.version;
    return profile;
  }
}
