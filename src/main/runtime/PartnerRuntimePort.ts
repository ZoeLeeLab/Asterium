import type { AsteriumRuntimeContextInput, CancelRunCommand, CodexRuntimeInfo, SendMessageCommand, SendMessageReceipt } from '../../shared/agentProtocol';
import { AGENT_PROTOCOL_VERSION } from '../../shared/agentProtocol';
import type { StudioPrepareTurnRequest, StudioPreparedTurn } from '../../shared/studioRuntime';
import type { StudioPartnerRecord } from '../studio/StudioRuntimeCatalog';
import type { ProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import type { FrozenTaskContract, TaskAttemptFailure } from '../../shared/projectTaskExecution';

export interface StudioRuntimeTurnRequest {
  partner: StudioPartnerRecord;
  prepared: StudioPreparedTurn;
  content: string;
  context: AsteriumRuntimeContextInput;
  contextHandoff?: SendMessageCommand['contextHandoff'];
}

export interface StudioRuntimeCancellation {
  partner: StudioPartnerRecord;
  conversationId: string;
  runId: string;
  sessionId: string;
  route: NonNullable<SendMessageCommand['route']>;
}

export interface PartnerRuntimePortDependencies {
  prepareTurn: (request: StudioPrepareTurnRequest) => Promise<StudioPreparedTurn>;
  startApi: (request: { connection: Extract<StudioPartnerRecord['runtime'], { kind: 'api' }>['connection']; command: SendMessageCommand }) => Promise<SendMessageReceipt>;
  startLocal: (request: {
    adapterType: 'claude_code' | 'codex_cli';
    partnerId: string;
    partnerRootGrantId?: string;
    workspaceGrantIds: string[];
    command: SendMessageCommand;
    codexRuntimeId?: string;
    codexRuntimeEnvironment?: CodexRuntimeInfo['environment'];
  }) => Promise<SendMessageReceipt>;
  cancelRun: (command: CancelRunCommand) => Promise<void>;
  startProjectTask?: ProjectTaskRuntimeLifecyclePort['startProjectTask'];
  projectTaskWriterScope?: ProjectTaskRuntimeLifecyclePort['workspaceWriterScope'];
}

export interface StudioRuntimeLifecyclePort {
  prepareStudioTurn: PartnerRuntimePort['prepareStudioTurn'];
  startStudioTurn: PartnerRuntimePort['startStudioTurn'];
  cancelRun: PartnerRuntimePort['cancelRun'];
}

export interface ProjectTaskRuntimeCommand {
  attemptId: string;
  projectId: string;
  taskId: string;
  taskRevision: number;
  partnerId: string;
  permissionMode: ProjectPermissionMode;
  contract: FrozenTaskContract;
  invocation: {
    type: 'initial' | 'resume' | 'retry';
    reason?: string;
    previousFailure?: TaskAttemptFailure;
  };
}

export type ProjectTaskRuntimeOutcome =
  | { type: 'succeeded' }
  | { type: 'paused'; reason?: string }
  | { type: 'cancelled'; reason?: string }
  | { type: 'failed'; error: { code: string; message: string; retryable: boolean } };

export interface ProjectTaskRuntimeHandle {
  runId: string;
  result: Promise<ProjectTaskRuntimeOutcome>;
  pause: (reason: string) => Promise<void>;
  cancel: (reason: string) => Promise<void>;
}

/** Workspace-task scope on the same runtime port used by Studio turns. */
export interface ProjectTaskRuntimeLifecyclePort {
  /** Shared project roots serialize real writers until worktrees are designed. */
  workspaceWriterScope?: 'project_partner' | 'project_workspace';
  startProjectTask: (command: ProjectTaskRuntimeCommand) => Promise<ProjectTaskRuntimeHandle>;
}

export class PartnerRuntimePort implements StudioRuntimeLifecyclePort, ProjectTaskRuntimeLifecyclePort {
  constructor(private readonly dependencies: PartnerRuntimePortDependencies) {}

  get workspaceWriterScope() {
    return this.dependencies.projectTaskWriterScope;
  }

  prepareStudioTurn(partner: StudioPartnerRecord, roomId: string, roundId: string) {
    const runtime = partner.runtime;
    if (runtime.kind === 'unsupported') throw new Error('STUDIO_PARTNER_RUNTIME_UNAVAILABLE');
    return this.dependencies.prepareTurn({
      roomId,
      roundId,
      partnerId: partner.partnerId,
      source: partner.sourceMode,
      ...(runtime.kind === 'local' ? {
        adapterType: runtime.adapterType,
        partnerRootGrantId: runtime.partnerRootGrantId,
        codexRuntimeId: runtime.codexRuntimeId,
        codexRuntimeEnvironment: runtime.codexRuntimeEnvironment,
      } : {}),
    });
  }

  async startStudioTurn({ partner, prepared, content, context, contextHandoff }: StudioRuntimeTurnRequest) {
    const route = {
      scope: 'group' as const,
      roomId: prepared.room.roomId,
      roundId: prepared.round.roundId,
      bindingGeneration: prepared.bindingGeneration,
      inputThroughSeq: prepared.inputThroughSeq,
    };
    const command: SendMessageCommand = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'message.send',
      commandId: makeId('studio-command'),
      partnerId: partner.partnerId,
      conversationId: prepared.conversationId,
      connectionSource: partner.sourceMode,
      clientMessageId: makeId('studio-turn'),
      sessionId: prepared.nativeThreadId,
      route,
      content: { type: 'text', text: content },
      ...(prepared.attachments?.length ? { attachments: prepared.attachments } : {}),
      execution: { permissionMode: prepared.round.permissionMode, planMode: 'default' },
      runtimeContext: context,
      ...(contextHandoff ? { contextHandoff } : {}),
    };
    if (partner.runtime.kind === 'api') {
      command.apiContext = {
        history: [],
        // The Main-owned Studio ledger remains the source of truth. The API
        // cache only preserves the isolated group runtime between turns.
        apiSessionHistoryEnabled: true,
      };
      return this.dependencies.startApi({ connection: partner.runtime.connection, command });
    }
    if (partner.runtime.kind === 'unsupported') throw new Error('STUDIO_PARTNER_RUNTIME_UNAVAILABLE');
    return this.dependencies.startLocal({
      adapterType: partner.runtime.adapterType,
      partnerId: partner.partnerId,
      partnerRootGrantId: partner.runtime.partnerRootGrantId,
      workspaceGrantIds: partner.runtime.workspaceGrantIds,
      command,
      codexRuntimeId: partner.runtime.codexRuntimeId,
      codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment,
    });
  }

  cancelRun(active: StudioRuntimeCancellation, reason: string) {
    if (active.partner.runtime.kind === 'unsupported') throw new Error('STUDIO_PARTNER_RUNTIME_UNAVAILABLE');
    return this.dependencies.cancelRun({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.cancel',
      commandId: `studio-cancel-${active.runId}`,
      partnerId: active.partner.partnerId,
      conversationId: active.conversationId,
      connectionSource: active.partner.runtime.kind === 'api' ? 'api_partner' : 'local_cli',
      clientMessageId: `studio-cancel-${active.runId}`,
      runId: active.runId,
      sessionId: active.sessionId,
      route: active.route,
      reason,
    });
  }

  startProjectTask(command: ProjectTaskRuntimeCommand) {
    if (!this.dependencies.startProjectTask) throw new Error('PROJECT_TASK_RUNTIME_NOT_CONNECTED');
    return this.dependencies.startProjectTask(command);
  }
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
