import { createHash } from 'node:crypto';
import type { SendMessageCommand } from '../../shared/agentProtocol';
import type { AutomationRun, AutomationTargetOption } from '../../shared/automations';
import type { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import type { ProjectWorkspaceStore } from '../project/ProjectWorkspaceStore';
import type { WriterLeaseCoordinator } from '../runtime/WriterLeaseCoordinator';
import type { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import type { AutomationRuntime } from './AutomationRuntime';

interface Dependencies {
  automationHandles: { runtime?: AutomationRuntime };
  conversationDeletions: ConversationDeletionService;
  nativeBindings: NativeThreadBindingStore;
  partnerWorkspaces: PartnerWorkspaceStore;
  projectWorkspaces: ProjectWorkspaceStore;
  singleChatMessages: SingleChatMessageStore;
  studioRooms: StudioRoomStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  useLegacyRunPath: boolean;
  writerLeases: WriterLeaseCoordinator;
}

export function createAutomationTargetPolicy(dependencies: Dependencies) {
  const { automationHandles, conversationDeletions, nativeBindings, partnerWorkspaces, projectWorkspaces, singleChatMessages, studioRooms, studioRuntimeCatalog, useLegacyRunPath, writerLeases } = dependencies;
  async function automationWorkspaceSignature(partnerId: string, projectId?: string) {
    const workspace = projectId ? await projectWorkspaces.get(projectId) : await partnerWorkspaces.grantIds(partnerId);
    return createHash('sha256').update(JSON.stringify(workspace ?? null)).digest('hex');
  }

  async function checkAutomation(run: AutomationRun, leaseOwner?: string) {
    const t = run.definition.target, partner = studioRuntimeCatalog.partner(t.partnerId);
    const unavailable = (reason: string) => ({ available: false, reason });
    if (useLegacyRunPath) return unavailable('旧运行路径尚不支持自动化');
    if (!partner || !partner.available || partner.sourceMode !== t.sourceMode) return unavailable('伙伴暂不可用');
    if (partner.sourceMode === 'existing_thread') return unavailable('外部宿主尚未声明自动化能力');
    if (!t.workspaceSignature || t.workspaceSignature !== await automationWorkspaceSignature(t.partnerId, t.projectId)) return unavailable('工作区已变化，请编辑后重新绑定');
    const binding = await nativeBindings.getForScope(t.partnerId, t.roomId ? 'group' : 'single', t.roomId ?? t.conversationId);
    if (!binding || binding.state !== 'active' || binding.nativeThreadId !== t.nativeThreadId || binding.generation !== t.bindingGeneration || binding.profileRecoveryRequired) return unavailable('原线程绑定已变化或需要恢复');
    const owner = writerLeases.ownerFor({ kind: 'conversation', partnerId: t.partnerId, conversationId: t.conversationId });
    if (owner && owner !== leaseOwner) return unavailable('原线程忙碌，等待空闲');
    if (t.roomId) {
      const room = await studioRooms.getRoom(t.roomId);
      if (!room || room.metadata.archived || room.metadata.projectId !== t.projectId || !room.metadata.memberIds.includes(t.partnerId) || room.mutedPartnerIds.includes(t.partnerId)) return unavailable('群聊资格或项目已变化');
      if (room.settings.speakingMode === 'selected_partners' && !room.settings.selectedPartnerIds.includes(t.partnerId)) return unavailable('目标伙伴不在当前指定发言成员中');
      if (room.activeRound && !['completed', 'cancelled', 'failed'].includes(room.activeRound.state)
        && room.activeRound.triggerMessageId !== `automation-trigger:${run.id}`) return unavailable('群聊正在进行另一轮');
      const projectOwner = writerLeases.ownerFor({ kind: 'project_workspace', projectId: t.projectId! });
      if (projectOwner && projectOwner !== `automation:${run.id}`) return unavailable('项目工作区忙碌');
    } else {
      const source = await singleChatMessages.getConversation(t.conversationId);
      if (await conversationDeletions.isDeleted(t.conversationId) || !source || source.partnerId !== t.partnerId || source.isArchived || source.isDisabled || source.sessionId !== t.nativeThreadId) return unavailable('原对话不可用');
      if (source.busy && !leaseOwner) return unavailable('原对话忙碌，等待空闲');
      const workspace = await partnerWorkspaces.grantIds(t.partnerId);
      if (source.partnerRootGrantId && source.partnerRootGrantId !== workspace?.cwdGrantId) return unavailable('请先切回原对话的工作区');
    }
    return { available: true };
  }

  async function attachAutomationCommand(command: SendMessageCommand) {
    if (command.route?.scope === 'group') {
      const run = automationHandles.runtime?.pendingGroup(command.route.roomId, command.partnerId);
      if (run) {
        const room = await studioRooms.getRoom(command.route.roomId);
        if (room?.activeRound?.triggerMessageId === `automation-trigger:${run.id}`) automationHandles.runtime?.attach(command, run.id);
      }
    } else automationHandles.runtime?.attach(command);
  }

  const targets = async () => {
    const targets: AutomationTargetOption[] = [];
    for (const c of await singleChatMessages.listMetadata()) {
      const partner = studioRuntimeCatalog.partner(c.partnerId);
      if (!partner || c.isArchived || c.isDisabled || !c.sessionId || await conversationDeletions.isDeleted(c.conversationId)) continue;
      const b = await nativeBindings.getForScope(c.partnerId, 'single', c.conversationId);
      if ((!b || b.state !== 'active' || b.nativeThreadId !== c.sessionId) && partner.sourceMode !== 'existing_thread') continue;
      targets.push({
        target: { partnerId: c.partnerId, conversationId: c.conversationId, sourceMode: partner.sourceMode, nativeThreadId: c.sessionId, bindingGeneration: b?.generation ?? 1, workspaceSignature: await automationWorkspaceSignature(c.partnerId) },
        label: `${partner.publicIdentity.displayName} · ${c.title || '单聊'}`, available: partner.sourceMode !== 'existing_thread' && partner.available,
        ...(partner.sourceMode === 'existing_thread' ? { reason: '外部宿主尚未声明自动化能力' } : {})
      });
    }
    for (const room of await studioRooms.listAll()) {
      if (room.metadata.archived) continue;
      for (const id of room.metadata.memberIds) {
        const p = studioRuntimeCatalog.partner(id), b = await nativeBindings.getForScope(id, 'group', room.metadata.roomId);
        if (!p || !b || b.state !== 'active' || !b.nativeThreadId) continue;
        targets.push({ target: { partnerId: id, conversationId: b.conversationId, nativeThreadId: b.nativeThreadId, bindingGeneration: b.generation, sourceMode: p.sourceMode, workspaceSignature: await automationWorkspaceSignature(id, room.metadata.projectId), roomId: room.metadata.roomId, projectId: room.metadata.projectId }, label: `${p.publicIdentity.displayName} · ${room.metadata.name}`, available: p.available && p.sourceMode !== 'existing_thread' });
      }
    }
    return targets;
  };
  return { automationWorkspaceSignature, checkAutomation, attachAutomationCommand, targets };
}
