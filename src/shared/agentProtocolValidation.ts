import { isCodexModelSelection } from './codexModels';
import { AGENT_PROTOCOL_VERSION, type AgentCommand, type JsonValue, type PartnerEvent } from './agentProtocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' && (value[key] as string).length > 0;
}

function isConnectionSource(value: unknown) {
  return value === 'existing_thread' || value === 'local_cli' || value === 'api_partner';
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function hasCommandBase(value: Record<string, unknown>) {
  return value.protocolVersion === AGENT_PROTOCOL_VERSION
    && hasString(value, 'commandId')
    && hasString(value, 'partnerId')
    && hasString(value, 'conversationId')
    && isConnectionSource(value.connectionSource)
    && isExecutionRoute(value.route);
}

function isExecutionRoute(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.scope === 'single') return true;
  if (value.scope === 'workspace') return hasString(value, 'projectId');
  if (value.scope === 'workflow_planning') return hasString(value, 'projectId')
    && hasString(value, 'roomId')
    && hasString(value, 'generationId')
    && Number.isSafeInteger(value.bindingGeneration)
    && (value.bindingGeneration as number) > 0;
  return value.scope === 'group'
    && hasString(value, 'roomId')
    && hasString(value, 'roundId')
    && Number.isSafeInteger(value.bindingGeneration)
    && (value.bindingGeneration as number) > 0
    && Number.isSafeInteger(value.inputThroughSeq)
    && (value.inputThroughSeq as number) >= 0;
}

export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!isRecord(value) || !hasCommandBase(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'message.send': {
      const content = value.content;
      return hasString(value, 'clientMessageId')
        && (value.messageId === undefined || hasString(value, 'messageId'))
        && isSingleChatSourceMessage(value.sourceMessage)
        && (value.sessionId === undefined || typeof value.sessionId === 'string')
        && isRecord(content)
        && content.type === 'text'
        && typeof content.text === 'string'
        && (content.text.trim().length > 0 || (Array.isArray(value.attachments) && value.attachments.length > 0))
        && isMessageAttachments(value.attachments)
        && isApiTextContext(value.apiContext)
        && isExecution(value.execution)
        && isRuntimeContext(value.runtimeContext);
    }
    case 'run.cancel':
      return hasString(value, 'clientMessageId') && hasString(value, 'runId') && hasString(value, 'sessionId');
    case 'guidance.send': {
      const content = value.content;
      return hasString(value, 'clientMessageId')
        && hasString(value, 'runId')
        && hasString(value, 'sessionId')
        && isSingleChatSourceMessage(value.sourceMessage)
        && (value.sourceMessage === undefined || (isRecord(value.sourceMessage) && value.sourceMessage.authorType === 'user'))
        && isRecord(content)
        && content.type === 'text'
        && typeof content.text === 'string'
        && content.text.trim().length > 0;
    }
    case 'session.resume':
      return hasString(value, 'sessionId')
        && Number.isSafeInteger(value.afterSequence)
        && (value.afterSequence as number) >= 0;
    case 'authorization.resolve':
      return hasString(value, 'clientMessageId')
        && hasString(value, 'runId')
        && hasString(value, 'sessionId')
        && hasString(value, 'authorizationId')
        && (value.decision === 'allow_once' || value.decision === 'deny')
        && (value.persistExtensionTrust === undefined || value.persistExtensionTrust === false
          || (value.persistExtensionTrust === true && value.connectionSource === 'api_partner' && value.decision === 'allow_once'));
    case 'user_input.resolve':
      return hasString(value, 'clientMessageId')
        && hasString(value, 'runId')
        && hasString(value, 'sessionId')
        && hasString(value, 'requestId')
        && isRecord(value.answers)
        && isCustomAnswers(value.customAnswers)
        && Object.values(value.answers).every((answer) => Array.isArray(answer) && answer.every((item) => typeof item === 'string'));
    default:
      return false;
  }
}

function isCustomAnswers(value: unknown) {
  return value === undefined || (isRecord(value) && Object.values(value).every((text) => typeof text === 'string'));
}

function isSingleChatSourceMessage(value: unknown) {
  if (value === undefined) return true;
  return isRecord(value) && hasString(value, 'messageId') && value.authorType === 'user'
    && hasString(value, 'authorId') && typeof value.content === 'string' && hasString(value, 'createdAt');
}

function isExecution(value: unknown) {
  if (value === undefined) return true;
  return isRecord(value)
    && ['read_only', 'manual', 'automatic', 'full'].includes(String(value.permissionMode))
    && (value.planMode === 'default' || value.planMode === 'plan')
    && (value.codexModel === undefined || isCodexModelSelection(value.codexModel));
}

function isMessageAttachments(value: unknown) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 10 && value.every((item) => isRecord(item)
    && hasString(item, 'id') && hasString(item, 'name') && hasString(item, 'mediaType')
    && Number.isSafeInteger(item.sizeBytes)
    && (item.sizeBytes as number) >= 0 && (item.sizeBytes as number) <= 20 * 1024 * 1024);
}

function isApiTextContext(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value) || (value.systemPrompt !== undefined && typeof value.systemPrompt !== 'string') || !Array.isArray(value.history) || value.history.length > 30) return false;
  if (value.apiSessionHistoryEnabled !== undefined && typeof value.apiSessionHistoryEnabled !== 'boolean') return false;
  if (value.memoryEnabled !== undefined && typeof value.memoryEnabled !== 'boolean') return false;
  if (value.replaceTurnClientMessageId !== undefined && typeof value.replaceTurnClientMessageId !== 'string') return false;
  if (value.userProfileContext !== undefined && (typeof value.userProfileContext !== 'string' || value.userProfileContext.length > 20_000)) return false;
  if (typeof value.systemPrompt === 'string' && value.systemPrompt.length > 20_000) return false;
  let historyCharacters = 0;
  for (const item of value.history) {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !item.content.trim()) return false;
    historyCharacters += item.content.length;
  }
  return historyCharacters <= 60_000;
}

function isRuntimeContext(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value) || !isRecord(value.partner) || !isRecord(value.runtime)) return false;
  if (value.memoryBriefing !== undefined && (typeof value.memoryBriefing !== 'string' || value.memoryBriefing.length > 20_000)) return false;
  const partner = value.partner;
  if (!['displayName', 'introduction', 'expertise', 'mentionName'].every((key) => typeof partner[key] === 'string' && (partner[key] as string).length <= 20_000)) return false;
  if (partner.personality !== undefined && (typeof partner.personality !== 'string' || partner.personality.length > 20_000)) return false;
  if (typeof partner.avatarAvailable !== 'boolean' || !isConnectionSource(value.runtime.source)) return false;
  if (value.user !== undefined && (!isRecord(value.user) || typeof value.user.displayName !== 'string' || typeof value.user.introduction !== 'string')) return false;
  if (value.conversation !== undefined && (!isRecord(value.conversation) || typeof value.conversation.title !== 'string')) return false;
  return true;
}

export function assertAgentCommand(value: unknown): asserts value is AgentCommand {
  if (!isAgentCommand(value)) throw new Error('INVALID_AGENT_COMMAND');
}

const partnerEventTypes = new Set([
  'session.bound',
  'message.accepted',
  'guidance.applied',
  'text.delta',
  'work.status',
  'reasoning.started',
  'reasoning.delta',
  'reasoning.completed',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'file.produced',
  'authorization.requested',
  'authorization.resolved',
  'user_input.requested',
  'user_input.resolved',
  'plan.updated',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'extension.event',
]);

export function isPartnerEvent(value: unknown): value is PartnerEvent {
  if (!isRecord(value)) return false;
  const validBase = value.protocolVersion === AGENT_PROTOCOL_VERSION
    && typeof value.type === 'string'
    && partnerEventTypes.has(value.type)
    && hasString(value, 'eventId')
    && hasString(value, 'partnerId')
    && hasString(value, 'conversationId')
    && isConnectionSource(value.connectionSource)
    && hasString(value, 'clientMessageId')
    && hasString(value, 'sessionId')
    && hasString(value, 'runId')
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) > 0
    && hasString(value, 'occurredAt');
  if (validBase && !isExecutionRoute(value.route)) return false;
  if (!validBase) return false;
  switch (value.type) {
    case 'session.bound': return typeof value.isNew === 'boolean'
      && (value.toolProtocolVersion === undefined || (Number.isSafeInteger(value.toolProtocolVersion) && (value.toolProtocolVersion as number) > 0));
    case 'message.accepted': return true;
    case 'guidance.applied': return value.connectionSource === 'api_partner' && hasString(value, 'guidanceClientMessageId')
      && isSingleChatSourceMessage(value.sourceMessage)
      && (value.sourceMessage === undefined || (isRecord(value.sourceMessage) && value.sourceMessage.authorType === 'user'));
    case 'text.delta': return typeof value.text === 'string';
    case 'work.status': return ['thinking', 'working', 'waiting_authorization', 'waiting_user_input', 'idle'].includes(String(value.state)) && typeof value.summary === 'string';
    case 'reasoning.started': return hasString(value, 'reasoningId') && hasString(value, 'summary');
    case 'reasoning.delta': return hasString(value, 'reasoningId') && typeof value.text === 'string';
    case 'reasoning.completed': return hasString(value, 'reasoningId')
      && (value.outcome === 'completed' || value.outcome === 'interrupted')
      && typeof value.truncated === 'boolean';
    case 'tool.started': return hasString(value, 'toolCallId') && hasString(value, 'toolName') && typeof value.summary === 'string' && typeof value.mutatesExternalState === 'boolean'
      && (value.presentationName === undefined || (typeof value.presentationName === 'string' && value.presentationName.length > 0 && value.presentationName.length <= 512));
    case 'tool.progress': return hasString(value, 'toolCallId') && typeof value.summary === 'string';
    case 'tool.completed': return hasString(value, 'toolCallId') && (value.outcome === 'success' || value.outcome === 'failure') && typeof value.summary === 'string';
    case 'file.produced': return hasString(value, 'artifactId') && hasString(value, 'name') && hasString(value, 'artifactRef')
      && (value.changeKind === undefined || value.changeKind === 'create' || value.changeKind === 'modify');
    case 'authorization.requested': return hasString(value, 'authorizationId') && hasString(value, 'summary') && Array.isArray(value.targets) && value.targets.every((target) => typeof target === 'string')
      && (value.purpose === undefined || ['operation', 'workspace_add', 'workspace_remove', 'command_native'].includes(String(value.purpose)))
      && (value.extensionTrust === undefined || (value.connectionSource === 'api_partner' && isRecord(value.extensionTrust)
        && hasString(value.extensionTrust, 'extensionId') && hasString(value.extensionTrust, 'name') && Number.isSafeInteger(value.extensionTrust.generation) && Number(value.extensionTrust.generation) >= 0
        && (value.extensionTrust.kind === undefined || value.extensionTrust.kind === 'mcp' || value.extensionTrust.kind === 'skill')));
    case 'authorization.resolved': return hasString(value, 'authorizationId') && (value.decision === 'allow_once' || value.decision === 'deny')
      && (value.extensionTrustGranted === undefined || value.extensionTrustGranted === false || (value.extensionTrustGranted === true && value.connectionSource === 'api_partner' && value.decision === 'allow_once'));
    case 'user_input.requested': return hasString(value, 'requestId') && Array.isArray(value.questions) && value.questions.length > 0;
    case 'user_input.resolved': return hasString(value, 'requestId') && isRecord(value.answers) && isCustomAnswers(value.customAnswers);
    case 'plan.updated': return ['planning', 'waiting_user', 'ready', 'executing', 'completed'].includes(String(value.status))
      && (value.planMode === undefined || value.planMode === 'default' || value.planMode === 'plan');
    case 'run.completed': return value.finishReason === 'completed' || value.finishReason === 'end_turn';
    case 'run.failed': return isRecord(value.error) && hasString(value.error, 'code') && hasString(value.error, 'message') && typeof value.error.retryable === 'boolean';
    case 'run.cancelled': return hasString(value, 'reason');
    case 'extension.event': return hasString(value, 'namespace')
      && hasString(value, 'name')
      && Number.isSafeInteger(value.schemaVersion)
      && (value.schemaVersion as number) > 0
      && isJsonValue(value.payload)
      && (value.correlationId === undefined || typeof value.correlationId === 'string');
    default: return false;
  }
}
