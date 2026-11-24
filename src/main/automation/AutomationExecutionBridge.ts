import { type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  AGENT_PROTOCOL_VERSION,
  type SendMessageCommand
} from '../../shared/agentProtocol';
import { trimChatHistory } from '../../shared/chatHistory';
import { AutomationAgentTools } from './AutomationAgentTools';
import { AutomationConfirmations } from './AutomationConfirmations';
import { AutomationRuntime } from './AutomationRuntime';
import { AutomationScheduler } from './AutomationScheduler';
import { AutomationService } from './AutomationService';
import { AutomationStore } from './AutomationStore';
import { automationPrompt } from './automationPrompt';
import { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import { ProjectExecutionPolicyStore } from '../project/ProjectExecutionPolicyStore';
import { createMessageRuntime } from '../runtime/MessageRuntime';
import { RunCoordinator } from '../runtime/RunCoordinator';
import { WriterLeaseCoordinator } from '../runtime/WriterLeaseCoordinator';
import { StudioMcpAccessStore } from '../studio/StudioMcpAccessStore';
import { StudioMcpService } from '../studio/StudioMcpService';
import { StudioRoomStore } from '../studio/StudioRoomStore';
import { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import type { createAutomationTargetPolicy } from './AutomationTargetPolicy';
interface Dependencies {
  automationConfirmations: AutomationConfirmations;
  automationHandles: { runtime?: AutomationRuntime; scheduler?: AutomationScheduler };
  automationService: AutomationService;
  automationStore: AutomationStore;
  checkAutomation: ReturnType<typeof createAutomationTargetPolicy>['checkAutomation'];
  getWindow: () => BrowserWindow | null;
  projectExecutionPolicies: ProjectExecutionPolicyStore;
  runCoordinator: RunCoordinator;
  singleChatMessages: SingleChatMessageStore;
  startApiRuntime: ReturnType<typeof createMessageRuntime>['startApiRuntime'];
  startLocalRuntime: ReturnType<typeof createMessageRuntime>['startLocalRuntime'];
  studioMcpAccess: StudioMcpAccessStore;
  studioMcpService: StudioMcpService;
  studioRooms: StudioRoomStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  writerLeases: WriterLeaseCoordinator;
}

export function createAutomationExecutionBridge(dependencies: Dependencies) {
  const { automationConfirmations, automationHandles, automationService, automationStore, checkAutomation, getWindow, projectExecutionPolicies, runCoordinator, singleChatMessages, startApiRuntime, startLocalRuntime, studioMcpAccess, studioMcpService, studioRooms, studioRuntimeCatalog, writerLeases } = dependencies;
  const automationProjectLeases = new Map<string, ReturnType<WriterLeaseCoordinator['tryAcquire']>>();

  const automationAgentTools = new AutomationAgentTools(automationService, async (request, owner) => {
    const window = getWindow(); if (!window || window.isDestroyed()) return false;
    if (request.action !== 'create' && request.action !== 'update' && request.action !== 'remove') return false;
    const task = 'input' in request ? request.input : (await automationStore.snapshot()).automations.find(d => d.id === request.id);
    if (!task) return false;
    const target = (await automationService.get(owner.partnerId)).targets.find(t => t.target.conversationId === task.target.conversationId);
    return automationConfirmations.request({
      action: request.action,
      partnerName: studioRuntimeCatalog.partner(owner.partnerId)?.publicIdentity.displayName ?? '伙伴', targetLabel: target?.label ?? '原对话',
      task: { name: task.name, instructions: task.instructions, schedule: task.schedule, timezone: task.timezone, catchUp: task.catchUp, notifications: task.notifications, enabled: task.enabled },
    }, owner.ownerKey, owner.signal);
  });

  const externalAutomation: NonNullable<StudioMcpService['automation']> = async (token, input) => {
    const identity = await studioMcpService.authenticate(token);
    const revalidate = async () => {
      if ((await studioMcpService.authenticate(token)).partnerId !== identity.partnerId) throw new Error('STUDIO_MCP_UNAUTHORIZED');
      if (!(await studioMcpAccess.snapshot()).configuration.automationManagementEnabled) throw new Error('AUTOMATION_EXTERNAL_DISABLED');
    };
    return automationAgentTools.call(input, { partnerId: identity.partnerId, automatic: false, revalidate });
  };

  automationHandles.runtime = new AutomationRuntime(automationStore, {
    check: run => checkAutomation(run),
    launch: async (run, signal) => {
      const t = run.definition.target, p = studioRuntimeCatalog.partner(t.partnerId);
      if (!p || p.runtime.kind === 'unsupported') throw new Error('AUTOMATION_PARTNER_UNAVAILABLE');
      const previous = (await automationStore.snapshot()).runs.filter(r => r.automationId === run.automationId && r.state === 'succeeded').slice(-3).map(r => ({ summary: r.summary?.slice(0, 8000), finishedAt: r.finishedAt }));
      const prompt = automationPrompt(run, previous);
      signal.throwIfAborted();
      if (t.roomId) {
        const lease = writerLeases.tryAcquire({ kind: 'project_workspace', projectId: t.projectId! }, `automation:${run.id}`);
        if (!lease) throw new Error('AUTOMATION_PROJECT_BUSY'); automationProjectLeases.set(run.id, lease);
        const policy = await projectExecutionPolicies.getOrCreate(t.projectId!);
        await studioRooms.publishAutomationMessage(t.roomId, t.partnerId, { automationId: run.automationId, runId: run.id, name: run.definition.name }, prompt, policy.permissionMode);
        return;
      }
      const source = await singleChatMessages.getConversation(t.conversationId); if (!source) throw new Error('AUTOMATION_SOURCE_MISSING');
      const command: SendMessageCommand = {
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: `automation-command:${run.id}`, clientMessageId: `automation:${run.id}`,
        partnerId: t.partnerId, conversationId: t.conversationId, connectionSource: t.sourceMode, sessionId: t.nativeThreadId,
        content: { type: 'text', text: prompt }, execution: { permissionMode: source.permissionMode ?? 'manual', planMode: source.planMode ?? 'default' },
        runtimeContext: {
          partner: { displayName: p.publicIdentity.displayName, introduction: p.publicIdentity.introduction, expertise: p.publicIdentity.expertise, mentionName: p.publicIdentity.mentionName, avatarAvailable: Boolean(p.publicIdentity.avatarDataUrl) },
          runtime: p.runtimeContext, user: studioRuntimeCatalog.user(), conversation: { title: source.title ?? run.definition.name }
        },
        apiContext: { apiSessionHistoryEnabled: source.apiSessionHistoryEnabled ?? true, history: trimChatHistory(source.messages.filter(m => m.fallbackEligible !== false).map(m => ({ role: m.authorType === 'user' ? 'user' as const : 'assistant' as const, content: m.content }))) },
      };
      automationHandles.runtime!.attach(command);
      if (p.runtime.kind === 'api') await startApiRuntime({ connection: p.runtime.connection, command });
      else await startLocalRuntime({
        adapterType: p.runtime.adapterType, partnerId: t.partnerId, partnerRootGrantId: p.runtime.partnerRootGrantId, workspaceGrantIds: p.runtime.workspaceGrantIds,
        codexRuntimeId: p.runtime.codexRuntimeId, codexRuntimeEnvironment: p.runtime.codexRuntimeEnvironment, command
      });
    },
    cancel: (command, receipt) => runCoordinator.cancel({ ...command, type: 'run.cancel', commandId: `automation-cancel:${randomUUID()}`, runId: receipt.runId, sessionId: receipt.sessionId, reason: '取消自动化本次执行' }),
    saveResult: async (run, summary, messageId, completed) => {
      if (run.definition.target.roomId) return;
      const now = new Date(); await singleChatMessages.upsertMessage(run.definition.target.conversationId, run.definition.target.partnerId, {
        messageId, automationRunId: run.id, authorType: 'partner', authorId: run.definition.target.partnerId, content: summary,
        createdAt: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), occurredAt: run.startedAt ?? now.toISOString(), completedAt: now.toISOString(), fallbackEligible: completed,
      });
    },
  });

  automationHandles.scheduler = new AutomationScheduler(automationStore, {
    check: run => automationHandles.runtime!.check(run),
    execute: async (run, signal) => { try { return await automationHandles.runtime!.execute(run, signal); } finally { automationProjectLeases.get(run.id)?.release(); automationProjectLeases.delete(run.id); } },
  });
  return { automationAgentTools, externalAutomation };
}
