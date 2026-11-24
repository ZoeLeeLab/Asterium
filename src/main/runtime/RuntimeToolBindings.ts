import type { SendMessageCommand } from '../../shared/agentProtocol';
import type { MemorySourceAnchor } from '../../shared/memoryArchive';
import type { AutomationAgentTools } from '../automation/AutomationAgentTools';
import type { AutomationRuntime } from '../automation/AutomationRuntime';
import type { PartnerMemoryToolService } from '../memory/PartnerMemoryToolService';
import type { PartnerProjectNotebookService } from '../notebook/PartnerProjectNotebookService';
import type { ProjectTaskRuntime } from '../project/ProjectTaskRuntime';
import type { ProjectWorkflowGenerationRuntime } from '../project/ProjectWorkflowGenerationRuntime';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { createAsteriumRuntimeTools, memoryToolAccess, projectNotebookToolAccess, type ProjectNotebookToolInput } from './AsteriumRuntimeTools';
import { delegationReportTools } from './DelegationConversationRuntime';
import type { DelegationResultDelivery } from './DelegationResultDelivery';
import type { createDelegationToolHandler } from './DelegationToolHandler';
interface Dependencies {
  automationAgentTools: () => AutomationAgentTools;
  automationHandles: { runtime?: AutomationRuntime };
  artifacts: ArtifactRegistry;
  delegationHandles: { delivery?: DelegationResultDelivery };
  delegationToolFor: ReturnType<typeof createDelegationToolHandler>;
  messageAttachments: ConversationAttachmentStore;
  partnerMemoryTools: PartnerMemoryToolService;
  partnerWorkspaces: PartnerWorkspaceStore;
  projectNotebooks: PartnerProjectNotebookService;
  projectTaskRuntimeRef: { current?: ProjectTaskRuntime };
  studioRooms: StudioRoomStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  workflowGenerationRuntimeRef: { current?: ProjectWorkflowGenerationRuntime };
}

export function createRuntimeToolBindings(dependencies: Dependencies) {
  const { automationAgentTools, automationHandles, artifacts, delegationHandles, delegationToolFor, messageAttachments, partnerMemoryTools, partnerWorkspaces, projectNotebooks, projectTaskRuntimeRef, studioRooms, studioRuntimeCatalog, workflowGenerationRuntimeRef } = dependencies;
  const currentMemorySource = async (command: SendMessageCommand): Promise<MemorySourceAnchor | undefined> => {
    if (command.route?.scope === 'group') {
      const route = command.route;
      const room = await studioRooms.getRoom(route.roomId);
      const triggerMessageId = room?.activeRound?.roundId === route.roundId
        ? room.activeRound.triggerMessageId
        : room?.messages.find((message) => message.roundId === route.roundId && message.authorType === 'user')?.messageId;
      return triggerMessageId ? { kind: 'studio', roomId: route.roomId, messageId: triggerMessageId } : undefined;
    }
    return command.messageId ? { kind: 'single_chat', conversationId: command.conversationId, messageId: command.messageId } : undefined;
  };

  const runtimeToolsFor = (command: SendMessageCommand, memoryMode?: string) => {
    const memoryAccess = memoryToolAccess(memoryMode, command.route);
    const notebookAccess = projectNotebookToolAccess(command.route);
    const memoryContext = async () => ({ partnerId: command.partnerId, currentSource: await currentMemorySource(command) });
    const projectNotebook = (input: ProjectNotebookToolInput) => projectNotebooks.callTool(command.partnerId, command.route?.scope === 'group' ? command.runtimeContext?.conversation?.studio?.projectId : undefined, input);
    const tools = createAsteriumRuntimeTools({
      ...((!command.route || command.route.scope === 'single') && command.sourceMessage?.authorType === 'user' && !automationHandles.runtime?.runFor(command) ? {
        delegation: delegationToolFor(command),
      } : {}),
      workspaceChangesAllowed: !automationHandles.runtime?.runFor(command),
      automation: (input, signal) => automationAgentTools().call(input, {
        partnerId: command.partnerId, conversationId: command.conversationId,
        ownerKey: command.clientMessageId, signal,
        permissionMode: command.execution?.permissionMode ?? 'manual',
        automatic: Boolean(automationHandles.runtime?.runFor(command)), readOnly: command.execution?.permissionMode === 'read_only' || command.execution?.planMode === 'plan',
        report: changed => automationHandles.runtime!.report(command, changed),
      }),
      partnerId: command.partnerId,
      conversationId: command.conversationId,
      permissionMode: command.execution?.permissionMode ?? 'manual',
      planMode: command.execution?.planMode ?? 'default',
      context: command.runtimeContext,
      route: command.route,
      ...(command.route?.scope === 'group' ? {
        mentionPartner: async ({ route, partnerId, targetPartnerId, label }: { route: Extract<NonNullable<SendMessageCommand['route']>, { scope: 'group' }>; partnerId: string; targetPartnerId: string; label: string }) => {
          await studioRooms.mentionPartner({
            ...route, partnerId, targetPartnerId, label,
            externalTarget: studioRuntimeCatalog.partner(targetPartnerId)?.sourceMode === 'existing_thread'
          });
        }
      } : {}),
      workspaces: partnerWorkspaces,
      artifacts,
      attachments: messageAttachments,
      ...projectTaskRuntimeRef.current?.toolOptions(command),
      ...workflowGenerationRuntimeRef.current?.toolOptions(command),
      ...(notebookAccess ? { projectNotebook } : {}),
      ...(memoryAccess === 'none' ? {} : {
        memory: {
          access: memoryAccess,
          search: async (input: Parameters<PartnerMemoryToolService['search']>[1]) => JSON.stringify(await partnerMemoryTools.search(await memoryContext(), input), null, 2),
          readSource: async (input: Parameters<PartnerMemoryToolService['readSource']>[1]) => JSON.stringify(await partnerMemoryTools.readSource(await memoryContext(), input), null, 2),
          ...(memoryAccess === 'write' ? {
            hold: async (input: Parameters<PartnerMemoryToolService['hold']>[1]) => JSON.stringify(await partnerMemoryTools.hold(await memoryContext(), input), null, 2),
            comment: async (input: Parameters<PartnerMemoryToolService['comment']>[1]) => JSON.stringify(await partnerMemoryTools.comment(await memoryContext(), input), null, 2),
            update: async (input: Parameters<PartnerMemoryToolService['update']>[1]) => JSON.stringify(await partnerMemoryTools.update(await memoryContext(), input), null, 2),
          } : {}),
        }
      }),
    });
    return delegationHandles.delivery?.owns(command) ? delegationReportTools(tools) : tools;
  };
  return runtimeToolsFor;
}
