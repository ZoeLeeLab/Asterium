import type { AsteriumAgentsApi, AsteriumAttachmentsApi } from '../../shared/desktopBridge';
import { ASTERIUM_USER_ID, isAsteriumUser } from '../../shared/identity';
import {
  AGENT_PROTOCOL_VERSION,
  type AsteriumRuntimeContextInput,
  type LocalThreadLifecycleRequest,
  type MessageAttachment,
  type PermissionMode,
  type ProtocolError,
} from '../../shared/agentProtocol';
import type { Conversation, LocalCliPartner, Message, MessageQuote, Partner, PrototypeAction, PrototypeState, UserProfile } from '../types/domain';
import { apiHistory, sharesUserProfile } from './apiContext';
import { formatMessageWithQuote, messageTextForRuntime } from './messageQuote';

export type WorkspaceSwitchDecision = 'switch_to_conversation_cwd' | 'new_session_in_current_cwd';

type SingleChatDispatch = (action: PrototypeAction) => void;
type SingleChatAgentsBridge = Pick<
  AsteriumAgentsApi,
  'getLocalThreadLifecycles' | 'sendExistingThreadMessage' | 'sendApiMessage' | 'sendLocalCliMessage' | 'sendClaudeMessage'
>;

export interface SingleChatRuntimeBridge {
  agents?: SingleChatAgentsBridge;
  attachments?: Pick<AsteriumAttachmentsApi, 'deleteConversation'>;
}

interface SingleChatRuntimeContext {
  state: PrototypeState;
  dispatch: SingleChatDispatch;
  bridge: SingleChatRuntimeBridge;
}

export interface SendSingleChatMessageRequest extends SingleChatRuntimeContext {
  conversationId: string;
  content: string;
  attachments?: MessageAttachment[];
  messageId?: string;
  workspaceDecision?: WorkspaceSwitchDecision;
  quote?: MessageQuote;
}

export interface RegenerateSingleChatTurnRequest extends SingleChatRuntimeContext {
  conversationId: string;
  editedContent?: string;
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function createSingleChatMessage(content: string, attachments?: MessageAttachment[], messageId?: string, quote?: MessageQuote): Message {
  const now = new Date();
  return {
    id: messageId ?? makeId('message'),
    authorId: ASTERIUM_USER_ID,
    content,
    ...(attachments?.length ? { attachments } : {}),
    ...(quote ? { quote } : {}),
    createdAt: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    occurredAt: now.toISOString(),
    status: 'delivered',
  };
}

export function nativeLifecycleRequest(partner: LocalCliPartner, threadIds: string[], partnerRootGrantId = partner.partnerRootGrantId): LocalThreadLifecycleRequest {
  return {
    adapterType: partner.adapterType,
    partnerId: partner.id,
    partnerRootGrantId,
    codexRuntimeId: partner.codexRuntimeId,
    codexRuntimeEnvironment: partner.codexRuntime?.environment,
    threadIds,
  };
}

export function conversationWorkspaceMismatch(partner: Partner | undefined, conversation: Conversation | undefined) {
  if (!partner || !conversation || partner.sourceMode !== 'local_cli') return false;
  const current = normalizeWorkspacePath(partner.partnerRoot);
  const bound = normalizeWorkspacePath(conversation.partnerRoot);
  return Boolean(current && bound && current !== bound);
}

export function conversationForCurrentWorkspace(partner: Extract<Partner, { sourceMode: 'local_cli' }>, conversation: Conversation) {
  if (!conversationWorkspaceMismatch(partner, conversation)) return conversation;
  const bindings = { ...(conversation.nativeSessionBindings ?? {}) };
  const previousKey = normalizeWorkspacePath(conversation.partnerRoot);
  if (previousKey && conversation.partnerRoot && conversation.sessionId) {
    bindings[previousKey] = {
      sessionId: conversation.sessionId,
      partnerRoot: conversation.partnerRoot,
      ...(conversation.partnerRootGrantId ? { partnerRootGrantId: conversation.partnerRootGrantId } : {}),
      ...(conversation.nativeToolProtocolVersion ? { toolProtocolVersion: conversation.nativeToolProtocolVersion } : {}),
    };
  }
  const nextKey = normalizeWorkspacePath(partner.partnerRoot);
  const existing = nextKey ? bindings[nextKey] : undefined;
  return {
    ...conversation,
    partnerRootKind: partner.partnerRootKind ?? 'private',
    partnerRoot: partner.partnerRoot,
    partnerRootGrantId: partner.partnerRootGrantId,
    workspaceGrantIds: partner.workspaceGrantIds ?? [],
    sessionId: existing?.sessionId,
    nativeToolProtocolVersion: existing?.toolProtocolVersion,
    nativeSessionBindings: bindings,
    lastRunId: undefined,
    lastSequence: undefined,
    runNotice: undefined,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWorkspacePath(value: string | undefined) {
  return value?.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
}

function visibleContext(messages: Message[], nextPrompt: string) {
  const transcript = messages.map((message) => `${isAsteriumUser(message.authorId) ? '用户' : '助手'}：${messageTextForRuntime(message)}`).join('\n\n');
  return transcript ? `以下是这段对话截至上一轮的可见上下文。请以它为上下文回答最后的新消息，不要复述上下文本身。\n\n${transcript}\n\n用户的新消息：${nextPrompt}` : nextPrompt;
}

function runtimeContext(partner: Partner, conversation: Conversation, profile: UserProfile, partners: Partner[]): AsteriumRuntimeContextInput {
  return {
    partner: {
      displayName: partner.publicIdentity.displayName,
      introduction: partner.publicIdentity.introduction,
      expertise: partner.publicIdentity.expertise,
      mentionName: partner.publicIdentity.mentionName,
      avatarAvailable: Boolean(partner.publicIdentity.avatarDataUrl),
      ...((partner.sourceMode === 'api_partner' ? partner.personality : partner.managedPersonality) ? {
        personality: partner.sourceMode === 'api_partner' ? partner.personality : partner.managedPersonality,
      } : {}),
    },
    ...(sharesUserProfile(partner) ? { user: { displayName: profile.displayName, introduction: profile.introduction } } : {}),
    runtime: {
      source: partner.sourceMode,
      ...(partner.sourceMode === 'local_cli' ? { adapter: partner.adapterType } : {}),
      ...(partner.sourceMode === 'api_partner' ? { provider: partner.provider, model: partner.model } : {}),
    },
    conversation: { title: conversation.title },
    partners: partners.filter((item) => !item.isRemoved).map((item) => {
      const model = item.id === partner.id ? conversation.runtimeModel ?? item.recentModel : item.recentModel;
      return {
        displayName: item.publicIdentity.displayName,
        expertise: item.publicIdentity.expertise,
        model: model?.model ?? '尚未报告',
        modelStatus: model?.status ?? 'unknown',
      };
    }),
  };
}

function localPermissionMode(partner: Extract<Partner, { sourceMode: 'local_cli' }>, conversation: Conversation): PermissionMode {
  const requested = conversation.permissionMode ?? partner.defaultPermissionMode ?? 'manual';
  return partner.adapterType === 'claude_code' && requested === 'automatic' ? 'manual' : requested;
}

export async function sendSingleChatMessage({
  state,
  dispatch,
  bridge,
  conversationId,
  content,
  attachments,
  messageId,
  workspaceDecision,
  quote,
}: SendSingleChatMessageRequest): Promise<boolean> {
  let conversation = state.conversations.find((item) => item.id === conversationId);
  let partner = state.partners.find((item) => item.id === conversation?.partnerId);
  const explicitlyStartingNewNativeThread = workspaceDecision === 'new_session_in_current_cwd';
  if (partner?.isRemoved || conversation?.isDisabled) return false;
  if (conversation && partner?.sourceMode === 'local_cli' && conversationWorkspaceMismatch(partner, conversation)) {
    if (!workspaceDecision) return false;
    if (workspaceDecision === 'new_session_in_current_cwd') {
      conversation = conversationForCurrentWorkspace(partner, conversation);
    } else {
      if (!conversation.partnerRoot || !conversation.partnerRootGrantId) return false;
      partner = {
        ...partner,
        partnerRootKind: conversation.partnerRootKind ?? 'imported',
        partnerRoot: conversation.partnerRoot,
        partnerRootGrantId: conversation.partnerRootGrantId,
      };
    }
  }
  const realLocal = partner?.sourceMode === 'local_cli' && (partner.connectionKind === 'local_claude' || partner.connectionKind === 'local_codex');
  const realApi = partner?.sourceMode === 'api_partner' && !partner.isPrototype && partner.configured;
  const realExisting = partner?.sourceMode === 'existing_thread' && !partner.isPrototype && partner.configured && partner.connectionStatus === 'connected';
  if (!conversation || !partner || (!realLocal && !realApi && !realExisting)) {
    dispatch({ type: 'sendChatMessage', conversationId, message: createSingleChatMessage(content, attachments, messageId, quote) });
    return true;
  }
  if (partner.sourceMode === 'local_cli' && partner.adapterType === 'codex_cli' && partner.connectionKind === 'local_codex' && conversation.sessionId) {
    const getLifecycles = bridge.agents?.getLocalThreadLifecycles;
    if (getLifecycles) try {
      const [result] = await getLifecycles(nativeLifecycleRequest(partner, [conversation.sessionId], conversation.partnerRootGrantId ?? partner.partnerRootGrantId));
      if (!result || result.state !== 'active') {
        if (result?.state === 'deleted') void bridge.attachments?.deleteConversation(conversationId).catch(() => undefined);
        dispatch({
          type: 'syncNativeThreadLifecycle',
          conversationId,
          state: result?.state ?? 'unavailable',
          checkedAt: result?.checkedAt ?? new Date().toISOString(),
          message: result?.message ?? '发送前无法确认原生线程状态，星丛没有改动或新建其他线程。',
        });
        return false;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dispatch({
        type: 'syncNativeThreadLifecycle',
        conversationId,
        state: 'unavailable',
        checkedAt: new Date().toISOString(),
        message: detail.includes('CODEX_NOT_LOGGED_IN')
          ? '当前选择的 Codex 运行时已退出登录，请在伙伴管理中重新检测。'
          : '无法连接上次选择的 Codex 运行时；星丛没有切换到其他来源，也没有发送消息。',
      });
      return false;
    }
  }
  if (realLocal && !conversation.sessionId && conversation.messages.length > 0 && !explicitlyStartingNewNativeThread) {
    dispatch({
      type: 'syncNativeThreadLifecycle',
      conversationId,
      state: 'unavailable',
      checkedAt: new Date().toISOString(),
      message: '这段星丛记录没有对应的原生线程，已阻止静默新建。请新建对话，或在伙伴管理中重新选择原生线程。',
    });
    return false;
  }
  const clientMessageId = makeId('client-message');
  const visibleMessageId = messageId ?? makeId('message');
  const visibleMessage = { ...createSingleChatMessage(content, attachments, visibleMessageId, quote), clientMessageId, status: 'sending' as const };
  const sourceMessage = { messageId: visibleMessage.id, authorType: 'user' as const, authorId: visibleMessage.authorId, content: visibleMessage.content, createdAt: visibleMessage.createdAt, occurredAt: visibleMessage.occurredAt };
  dispatch({
    type: 'sendChatMessage',
    conversationId,
    message: visibleMessage,
  });
  const runtimeContent = formatMessageWithQuote(content, quote);
  const fail = (error: ProtocolError) => dispatch({ type: 'messageSendFailed', conversationId, clientMessageId, error });
  if (partner.sourceMode === 'existing_thread') {
    if (!partner.credentialRef || !bridge.agents?.sendExistingThreadMessage) {
      fail({ code: 'CYBERBOSS_CREDENTIAL_REQUIRED', message: '请先在伙伴管理中重新连接 CyberBoss。', stage: 'authorization', retryable: true });
      return false;
    }
    const command = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'message.send',
      commandId: makeId('command'),
      partnerId: partner.id,
      conversationId,
      connectionSource: 'existing_thread',
      clientMessageId,
      messageId: visibleMessageId,
      sourceMessage,
      sessionId: partner.threadId,
      content: { type: 'text', text: runtimeContent },
      ...(attachments?.length ? { attachments } : {}),
      runtimeContext: runtimeContext(partner, conversation, state.userProfile, state.partners),
    } as const;
    void bridge.agents.sendExistingThreadMessage({ serviceUrl: partner.serviceUrl, threadId: partner.threadId, ...(partner.workspaceRoot ? { workspaceRoot: partner.workspaceRoot } : {}), credentialRef: partner.credentialRef }, command)
      .then((receipt) => dispatch({ type: 'bindRunReceipt', conversationId, clientMessageId, ...receipt }))
      .catch(() => fail({ code: 'CYBERBOSS_SEND_FAILED', message: '消息未能发送给外部伙伴，请检查 Tailscale 或重新连接。', stage: 'transport', retryable: true }));
    return true;
  }
  if (partner.sourceMode === 'api_partner') {
    if (!partner.credentialRef || !bridge.agents?.sendApiMessage) {
      fail({ code: 'API_CREDENTIAL_REQUIRED', message: '请先在伙伴管理中配置 DeepSeek API Key。', stage: 'authorization', retryable: true });
      return false;
    }
    const command = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'message.send',
      commandId: makeId('command'),
      partnerId: partner.id,
      conversationId,
      connectionSource: partner.sourceMode,
      clientMessageId,
      messageId: visibleMessageId,
      sourceMessage,
      sessionId: conversation.sessionId,
      content: { type: 'text', text: runtimeContent },
      ...(attachments?.length ? { attachments } : {}),
      apiContext: {
        history: partner.apiSessionHistoryEnabled ? apiHistory(conversation.messages) : [],
        apiSessionHistoryEnabled: partner.apiSessionHistoryEnabled,
      },
      execution: { permissionMode: conversation.permissionMode ?? partner.defaultPermissionMode ?? 'manual', planMode: conversation.planMode ?? 'default' },
      runtimeContext: runtimeContext(partner, conversation, state.userProfile, state.partners),
    } as const;
    void bridge.agents.sendApiMessage({
      provider: partner.provider,
      endpoint: partner.endpoint ?? '',
      model: partner.model,
      credentialRef: partner.credentialRef,
      thinkingMode: partner.thinkingMode,
      reasoningEffort: partner.reasoningEffort,
      primaryWorkspaceGrantId: partner.primaryWorkspaceGrantId,
      workspaceGrantIds: partner.workspaceGrantIds,
      attachmentCapabilities: partner.attachmentCapabilities,
    }, command).then((receipt) => dispatch({ type: 'bindRunReceipt', conversationId, clientMessageId, ...receipt })).catch((error) => fail({
      code: 'API_SEND_FAILED',
      message: error instanceof Error && error.message.includes('API_CREDENTIAL_REQUIRED') ? 'DeepSeek API Key 已失效，请在伙伴管理中重新保存。' : '消息未能发送给 DeepSeek。',
      stage: 'transport',
      retryable: true,
    }));
    return true;
  }
  const grantIds = partner.workspaceGrantIds ?? [];
  const partnerRootGrantId = partner.partnerRootGrantId;
  if (!bridge.agents) {
    fail({ code: 'LOCAL_BRIDGE_UNAVAILABLE', message: '本地桥接暂不可用。', stage: 'transport', retryable: true });
    return false;
  }
  if (partner.adapterType === 'codex_cli' && !partner.codexRuntimeId) {
    fail({ code: 'CODEX_RUNTIME_SELECTION_REQUIRED', message: '请在伙伴管理中重新检测并选择 Codex 运行时。', stage: 'authorization', retryable: true });
    return false;
  }
  const command = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: makeId('command'),
    partnerId: partner.id,
    conversationId,
    connectionSource: partner.sourceMode,
    clientMessageId,
    messageId: visibleMessageId,
    sourceMessage,
    sessionId: conversation.sessionId,
    content: { type: 'text', text: runtimeContent },
    execution: { permissionMode: localPermissionMode(partner, conversation), planMode: conversation.planMode ?? 'default' },
    runtimeContext: runtimeContext(partner, conversation, state.userProfile, state.partners),
    ...(attachments?.length ? { attachments } : {}),
  } as const;
  const send = bridge.agents.sendLocalCliMessage
    ? bridge.agents.sendLocalCliMessage(partner.adapterType, partner.id, partnerRootGrantId, grantIds, command, partner.codexRuntimeId, partner.codexRuntime?.environment)
    : bridge.agents.sendClaudeMessage(partner.id, partnerRootGrantId, grantIds, command);
  void send.then((receipt) => dispatch({ type: 'bindRunReceipt', conversationId, clientMessageId, ...receipt })).catch((error) => fail({
    code: 'LOCAL_CLI_SEND_FAILED',
    message: error instanceof Error && error.message.includes('PARTNER_ROOT_GRANT_REQUIRED') ? '伙伴配置来源授权已失效，请在伙伴管理中重新导入。' : `消息未能发送给 ${partner.adapterType === 'codex_cli' ? 'Codex' : 'Claude Code'}。`,
    stage: 'transport',
    retryable: true,
    technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
  }));
  return true;
}

export function regenerateSingleChatTurn({ state, dispatch, bridge, conversationId, editedContent }: RegenerateSingleChatTurnRequest) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  const partner = state.partners.find((item) => item.id === conversation?.partnerId);
  if (!conversation || !partner || conversation.activeRun || conversation.isDisabled || conversationWorkspaceMismatch(partner, conversation) || partner.sourceMode === 'existing_thread') return;
  let userIndex = -1;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    if (isAsteriumUser(conversation.messages[index].authorId)) { userIndex = index; break; }
  }
  if (userIndex < 0) return;
  const content = editedContent?.trim() || conversation.messages[userIndex].content;
  const attachments = conversation.messages[userIndex].attachments;
  const quote = conversation.messages[userIndex].quote;
  const messageId = conversation.messages[userIndex].id;
  if (!content && !attachments?.length) return;
  const history = conversation.messages.slice(0, userIndex);
  const realLocal = partner.sourceMode === 'local_cli' && (partner.connectionKind === 'local_claude' || partner.connectionKind === 'local_codex');
  const realApi = partner.sourceMode === 'api_partner' && !partner.isPrototype && partner.configured;
  dispatch({ type: 'replaceLastTurn', conversationId, messages: history, sessionId: realApi ? conversation.sessionId : undefined, restoreOnFailure: realLocal || realApi });
  if (!realLocal && !realApi) {
    dispatch({ type: 'sendChatMessage', conversationId, message: createSingleChatMessage(content, attachments, messageId, quote) });
    return;
  }
  const clientMessageId = makeId('client-message');
  const visibleMessage = { ...createSingleChatMessage(content, attachments, messageId, quote), clientMessageId, status: 'sending' as const };
  const sourceMessage = { messageId: visibleMessage.id, authorType: 'user' as const, authorId: visibleMessage.authorId, content: visibleMessage.content, createdAt: visibleMessage.createdAt, occurredAt: visibleMessage.occurredAt };
  dispatch({ type: 'sendChatMessage', conversationId, message: visibleMessage });
  const runtimeContent = formatMessageWithQuote(content, quote);
  const fail = (error: ProtocolError) => dispatch({ type: 'messageSendFailed', conversationId, clientMessageId, error });
  if (partner.sourceMode === 'api_partner') {
    if (!partner.credentialRef || !bridge.agents?.sendApiMessage) return fail({ code: 'API_CREDENTIAL_REQUIRED', message: '请先在伙伴管理中配置 API Key。', stage: 'authorization', retryable: true });
    const command = {
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: makeId('command'), partnerId: partner.id, conversationId,
      connectionSource: partner.sourceMode, clientMessageId, sessionId: conversation.sessionId, content: { type: 'text', text: runtimeContent },
      messageId,
      sourceMessage,
      ...(attachments?.length ? { attachments } : {}),
      apiContext: {
        history: partner.apiSessionHistoryEnabled ? apiHistory(history) : [],
        apiSessionHistoryEnabled: partner.apiSessionHistoryEnabled,
        ...(conversation.messages[userIndex].clientMessageId ? { replaceTurnClientMessageId: conversation.messages[userIndex].clientMessageId } : {}),
      },
      execution: { permissionMode: conversation.permissionMode ?? partner.defaultPermissionMode ?? 'manual', planMode: conversation.planMode ?? 'default' },
      runtimeContext: runtimeContext(partner, conversation, state.userProfile, state.partners),
    } as const;
    void bridge.agents.sendApiMessage({
      provider: partner.provider,
      endpoint: partner.endpoint ?? '',
      model: partner.model,
      credentialRef: partner.credentialRef,
      thinkingMode: partner.thinkingMode,
      reasoningEffort: partner.reasoningEffort,
      primaryWorkspaceGrantId: partner.primaryWorkspaceGrantId,
      workspaceGrantIds: partner.workspaceGrantIds,
      attachmentCapabilities: partner.attachmentCapabilities,
    }, command)
      .then((receipt) => dispatch({ type: 'bindRunReceipt', conversationId, clientMessageId, ...receipt }))
      .catch(() => fail({ code: 'API_SEND_FAILED', message: '重新生成失败，请稍后重试。', stage: 'transport', retryable: true }));
    return;
  }
  const grantIds = partner.workspaceGrantIds ?? [];
  const partnerRootGrantId = partner.partnerRootGrantId;
  if (!bridge.agents) return fail({ code: 'LOCAL_BRIDGE_UNAVAILABLE', message: '本地桥接暂不可用。', stage: 'transport', retryable: true });
  const previousCodexTurnId = partner.adapterType === 'codex_cli'
    ? [...history].reverse().find((message) => !isAsteriumUser(message.authorId) && Boolean(message.runId))?.runId
    : undefined;
  const canForkCodex = Boolean(partner.adapterType === 'codex_cli' && conversation.sessionId && previousCodexTurnId);
  const command = {
    protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: makeId('command'), partnerId: partner.id, conversationId,
    connectionSource: partner.sourceMode, clientMessageId,
    messageId,
    sourceMessage,
    sessionId: canForkCodex ? conversation.sessionId : undefined,
    ...(canForkCodex ? { forkFromTurnId: previousCodexTurnId } : {}),
    content: { type: 'text', text: canForkCodex ? runtimeContent : visibleContext(history, runtimeContent) },
    execution: { permissionMode: localPermissionMode(partner, conversation), planMode: conversation.planMode ?? 'default' },
    ...(attachments?.length ? { attachments } : {}),
    runtimeContext: runtimeContext(partner, conversation, state.userProfile, state.partners),
  } as const;
  const send = bridge.agents.sendLocalCliMessage
    ? bridge.agents.sendLocalCliMessage(partner.adapterType, partner.id, partnerRootGrantId, grantIds, command, partner.codexRuntimeId, partner.codexRuntime?.environment)
    : bridge.agents.sendClaudeMessage(partner.id, partnerRootGrantId, grantIds, command);
  void send
    .then((receipt) => dispatch({ type: 'bindRunReceipt', conversationId, clientMessageId, ...receipt }))
    .catch(() => fail({ code: 'LOCAL_CLI_SEND_FAILED', message: '重新生成失败，请稍后重试。', stage: 'transport', retryable: true }));
}
