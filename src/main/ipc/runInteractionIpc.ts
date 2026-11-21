import type { AutomationConfirmations } from '../automation/AutomationConfirmations';
import type { ContextHandoffService } from '../runtime/ContextHandoffService';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { ResolveUserInputCommand, SendGuidanceCommand, SendGuidanceResult, ApiPartnerConnection, CodexRuntimeInfo, SendMessageCommand, SendMessageReceipt, CancelRunCommand, ResolveAuthorizationCommand, ResumeSessionCommand } from '../../shared/agentProtocol';
import { assertAgentCommand } from '../../shared/agentProtocolValidation';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { RunCoordinator } from '../runtime/RunCoordinator';

export function registerRunGuidanceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  runCoordinator: Pick<RunCoordinator, 'sendGuidance'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.sendGuidance, async (event, value: unknown): Promise<SendGuidanceResult> => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'guidance.send') throw new Error('INVALID_GUIDANCE_COMMAND');
    return runCoordinator.sendGuidance(value as SendGuidanceCommand);
  });
}

export function registerRunUserInputIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  runCoordinator: Pick<RunCoordinator, 'resolveUserInput'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.resolveUserInput, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'user_input.resolve') throw new Error('INVALID_USER_INPUT_COMMAND');
    await runCoordinator.resolveUserInput(value as ResolveUserInputCommand);
  });
}

type LocalAdapterType = 'claude_code' | 'codex_cli';

export interface ApiSendRequest {
  connection: ApiPartnerConnection;
  command: SendMessageCommand;
  projectRootOverride?: string;
}

export interface LocalCliSendRequest {
  adapterType: LocalAdapterType;
  codexRuntimeId?: string;
  codexRuntimeEnvironment?: CodexRuntimeInfo['environment'];
  partnerId: string;
  partnerRootGrantId?: string;
  workspaceGrantIds: string[];
  command: SendMessageCommand;
  projectRootOverride?: string;
}

interface MessageRunDependencies {
  contextHandoff: Pick<ContextHandoffService, 'validate'>;
  withDelegationChatPriority<T>(conversationId: string, start: () => Promise<T>): Promise<T>;
}

export function registerApiMessageIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { contextHandoff, withDelegationChatPriority, startApiRuntime, isAttachmentCapabilities }: MessageRunDependencies & {
    startApiRuntime: (request: ApiSendRequest) => Promise<SendMessageReceipt>;
    isAttachmentCapabilities: (value: unknown) => boolean;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  function isApiSendRequest(value: unknown): value is ApiSendRequest {
    return isRecord(value)
      && isRecord(value.connection)
      && ['deepseek', 'openai', 'responses', 'anthropic', 'gemini', 'custom'].includes(String(value.connection.provider))
      && typeof value.connection.endpoint === 'string'
      && typeof value.connection.model === 'string'
      && typeof value.connection.credentialRef === 'string'
      && (value.connection.thinkingMode === undefined || ['auto', 'enabled', 'disabled'].includes(String(value.connection.thinkingMode)))
      && (value.connection.reasoningEffort === undefined || ['low', 'high', 'max'].includes(String(value.connection.reasoningEffort)))
      && (value.connection.primaryWorkspaceGrantId === undefined || typeof value.connection.primaryWorkspaceGrantId === 'string')
      && (value.connection.workspaceGrantIds === undefined || (Array.isArray(value.connection.workspaceGrantIds) && value.connection.workspaceGrantIds.every((item) => typeof item === 'string')))
      && (value.connection.attachmentCapabilities === undefined || isAttachmentCapabilities(value.connection.attachmentCapabilities))
      && isRecord(value.command);
  }

  ipcMain.handle(AGENT_IPC.sendApiMessage, async (event, value: unknown) => {
    requireSender(event);
    if (!isApiSendRequest(value)) throw new Error('INVALID_API_SEND_REQUEST');
    assertAgentCommand(value.command);
    const request = value as ApiSendRequest;
    if (request.command.type !== 'message.send' || request.command.connectionSource !== 'api_partner') throw new Error('INVALID_API_SEND_COMMAND');
    if (request.command.contextHandoff !== undefined) {
      if (request.command.route) throw new Error('HANDOFF_SCOPE_UNAVAILABLE');
      request.command.contextHandoff = await contextHandoff.validate(request.command.contextHandoff, { kind: 'single', id: request.command.conversationId }, request.command.partnerId);
    }
    return withDelegationChatPriority(request.command.conversationId, () => startApiRuntime(request));
  });
}

export function registerLocalMessageIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { contextHandoff, withDelegationChatPriority, startLocalRuntime }: MessageRunDependencies & {
    startLocalRuntime: (request: LocalCliSendRequest) => Promise<SendMessageReceipt>;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.sendMessage, async (event, value: unknown) => {
    requireSender(event);
    if (!isLocalSendRequest(value)) throw new Error('INVALID_LOCAL_CLI_SEND_REQUEST');
    assertAgentCommand(value.command);
    if (value.command.type !== 'message.send') throw new Error('INVALID_LOCAL_CLI_SEND_COMMAND');
    const request = value as LocalCliSendRequest;
    if (request.command.connectionSource !== 'local_cli') throw new Error('INVALID_LOCAL_CLI_CONNECTION_SOURCE');
    if (request.command.contextHandoff !== undefined) {
      if (request.command.route || request.partnerId !== request.command.partnerId) throw new Error('HANDOFF_SCOPE_UNAVAILABLE');
      request.command.contextHandoff = await contextHandoff.validate(request.command.contextHandoff, { kind: 'single', id: request.command.conversationId }, request.command.partnerId);
    }
    return withDelegationChatPriority(request.command.conversationId, () => startLocalRuntime(request));
  });
}

export function registerRunControlIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { runCoordinator, automationConfirmations }: {
    runCoordinator: Pick<RunCoordinator, 'cancel' | 'sendGuidance' | 'resolveAuthorization' | 'resolveUserInput' | 'resume'>;
    automationConfirmations: Pick<AutomationConfirmations, 'cancelOwner'>;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.cancelRun, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'run.cancel') throw new Error('INVALID_CANCEL_COMMAND');
    automationConfirmations.cancelOwner(value.clientMessageId);
    await runCoordinator.cancel(value as CancelRunCommand);
  });

  registerRunGuidanceIpc(ipcMain, runCoordinator, requireSender);

  ipcMain.handle(AGENT_IPC.resolveAuthorization, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'authorization.resolve') throw new Error('INVALID_AUTHORIZATION_COMMAND');
    await runCoordinator.resolveAuthorization(value as ResolveAuthorizationCommand);
  });

  registerRunUserInputIpc(ipcMain, runCoordinator, requireSender);

  ipcMain.handle(AGENT_IPC.resumeSession, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'session.resume') throw new Error('INVALID_RESUME_COMMAND');
    await runCoordinator.resume(value as ResumeSessionCommand);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalAdapterType(value: unknown): value is LocalAdapterType {
  return value === 'claude_code' || value === 'codex_cli';
}

function isLocalSendRequest(value: unknown): value is LocalCliSendRequest {
  return isRecord(value)
    && isLocalAdapterType(value.adapterType)
    && typeof value.partnerId === 'string'
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && Array.isArray(value.workspaceGrantIds)
    && value.workspaceGrantIds.every((item) => typeof item === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))
    && isRecord(value.command);
}
